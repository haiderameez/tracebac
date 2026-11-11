import { createHash } from 'node:crypto';
import { BUDGET, FRESH_MS, SEARCH_ORDER, type SearchId } from './config.ts';
import type { Volatility } from './types.ts';

export interface SearchQuery {
  q: string;
  since?: string;
  volatility: Volatility;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  score: number;
  publishedAt?: number;
}

export interface Page {
  url: string;
  title: string;
  text: string;
  fetchedAt: number;
}

export type Outcome<T> = { ok: true; value: T; cached: boolean; provider: string } | { ok: false; error: string };

export interface Cache {
  get(key: string): { body: string; fetchedAt: number } | undefined;
  put(key: string, kind: 'search' | 'page', body: string, ttlS: number, now: number): void;
}

export interface WebSearch {
  search(queries: SearchQuery[], opts: { signal: AbortSignal }): Promise<Outcome<SearchHit[]>[]>;
  read(urls: string[], opts: { fresh: boolean; volatility: Volatility; signal: AbortSignal }): Promise<Outcome<Page>[]>;
}

export interface WebSearchDeps {
  keys: Partial<Record<SearchId, string>>;
  jinaKey?: string;
  cache: Cache;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
}

const MAX_PAGE_CHARS = 60000;
const MIN_PAGE_CHARS = 200;
const BLOCKED = /(enable javascript|captcha|access denied|attention required|are you a robot|just a moment|verify you are human)/i;

class HttpError extends Error {
  status: number;
  retryAfter: number;
  constructor(status: number, message: string, retryAfter = 0) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 120);

export function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|ref$|ref_src$)/i.test(key)) u.searchParams.delete(key);
    u.hostname = u.hostname.replace(/^www\./i, '').toLowerCase();
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    return u.toString();
  } catch {
    return raw.trim();
  }
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return url;
  }
}

export function cleanMarkdown(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/^ +| +$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseJina(raw: string): { title: string; text: string } {
  const title = raw.match(/^Title:\s*(.*)$/m)?.[1]?.trim() ?? '';
  const marker = raw.indexOf('Markdown Content:');
  const body = marker >= 0 ? raw.slice(marker + 'Markdown Content:'.length) : raw;
  return { title, text: cleanMarkdown(body).slice(0, MAX_PAGE_CHARS) };
}

export async function pooled<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const parseDate = (value: unknown): number | undefined => {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : undefined;
};

function cooldownFor(e: unknown): number {
  if (!(e instanceof HttpError)) return 10000;
  if (e.status === 429) return e.retryAfter > 0 ? e.retryAfter * 1000 : 30000;
  if (e.status === 401 || e.status === 403) return 600000;
  if (e.status === 402 || e.status === 432 || e.status === 433) return 3600000;
  if (e.status >= 500) return 15000;
  return 0;
}

export function createWebSearch(deps: WebSearchDeps): WebSearch {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const cooldown = new Map<string, number>();

  const available = (id: string) => (cooldown.get(id) ?? 0) <= now();
  const cool = (id: string, e: unknown) => {
    const ms = cooldownFor(e);
    if (ms) cooldown.set(id, now() + ms);
  };

  async function postJson(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<any> {
    const res = await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
      throw new HttpError(res.status, `${res.status} ${text}`.trim(), Number(res.headers.get('retry-after')) || 0);
    }
    return res.json();
  }

  const adapters: Record<SearchId, (q: SearchQuery, key: string, signal: AbortSignal) => Promise<SearchHit[]>> = {
    async tavily(q, key, signal) {
      const data = await postJson(
        'https://api.tavily.com/search',
        { authorization: `Bearer ${key}` },
        { query: q.q, search_depth: 'basic', max_results: 6, topic: 'general', ...(q.since ? { start_date: q.since } : {}) },
        signal,
      );
      return (data.results ?? []).map((r: any) => ({
        title: r.title || r.url, url: r.url, snippet: r.content ?? '', score: Number(r.score) || 0, publishedAt: parseDate(r.published_date),
      }));
    },
    async exa(q, key, signal) {
      const data = await postJson(
        'https://api.exa.ai/search',
        { 'x-api-key': key },
        { query: q.q, type: 'auto', numResults: 6, contents: { text: { maxCharacters: 1200 } }, ...(q.since ? { startPublishedDate: `${q.since}T00:00:00Z` } : {}) },
        signal,
      );
      return (data.results ?? []).map((r: any, i: number) => ({
        title: r.title || r.url, url: r.url, snippet: r.text ?? '', score: 1 - i / 10, publishedAt: parseDate(r.publishedDate),
      }));
    },
    async serper(q, key, signal) {
      const data = await postJson('https://google.serper.dev/search', { 'x-api-key': key }, { q: q.q, num: 6 }, signal);
      return (data.organic ?? []).map((r: any, i: number) => ({
        title: r.title || r.link, url: r.link, snippet: r.snippet ?? '', score: 1 - i / 10, publishedAt: parseDate(r.date),
      }));
    },
  };

  async function searchOne(q: SearchQuery, signal: AbortSignal): Promise<Outcome<SearchHit[]>> {
    const key = sha(`search|${q.q.toLowerCase().replace(/\s+/g, ' ').trim()}|${q.since ?? ''}`);
    const cached = deps.cache.get(key);
    if (cached && now() - cached.fetchedAt < FRESH_MS[q.volatility]) {
      return { ok: true, value: JSON.parse(cached.body), cached: true, provider: 'cache' };
    }

    const errors: string[] = [];
    for (const id of SEARCH_ORDER) {
      const apiKey = deps.keys[id];
      if (!apiKey) continue;
      if (!available(id)) {
        errors.push(`${id}: cooling down`);
        continue;
      }
      if (signal.aborted) return { ok: false, error: 'aborted' };
      try {
        const hits = (await adapters[id](q, apiKey, AbortSignal.any([signal, AbortSignal.timeout(BUDGET.perSearchMs)]))).filter((h) => h.url);
        if (hits.length) deps.cache.put(key, 'search', JSON.stringify(hits), FRESH_MS[q.volatility] / 1000, now());
        return { ok: true, value: hits, cached: false, provider: id };
      } catch (e) {
        if (signal.aborted) return { ok: false, error: 'aborted' };
        cool(id, e);
        errors.push(`${id}: ${describe(e)}`);
        log(`search ${id}: ${describe(e)}`);
      }
    }
    return { ok: false, error: errors.join('; ') || 'no search provider configured' };
  }

  async function jinaRead(url: string, fresh: boolean, signal: AbortSignal) {
    const headers: Record<string, string> = { 'X-Respond-With': 'markdown', 'x-timeout': String(Math.ceil(BUDGET.perReadMs / 1000)) };
    if (deps.jinaKey) headers.authorization = `Bearer ${deps.jinaKey}`;
    if (fresh) headers['x-no-cache'] = 'true';
    const res = await doFetch(`https://r.jina.ai/${url}`, { headers, signal });
    if (!res.ok) throw new HttpError(res.status, `${res.status}`, Number(res.headers.get('retry-after')) || 0);
    return parseJina(await res.text());
  }

  async function tavilyExtract(url: string, signal: AbortSignal) {
    const data = await postJson('https://api.tavily.com/extract', { authorization: `Bearer ${deps.keys.tavily}` }, { urls: [url], extract_depth: 'basic', format: 'markdown' }, signal);
    const raw = data.results?.[0]?.raw_content;
    if (!raw) throw new Error('extract returned nothing');
    return { title: '', text: cleanMarkdown(String(raw)).slice(0, MAX_PAGE_CHARS) };
  }

  const usable = (text: string) => text.length >= MIN_PAGE_CHARS && !(text.length < 3000 && BLOCKED.test(text));

  async function readOne(url: string, opts: { fresh: boolean; volatility: Volatility; signal: AbortSignal }): Promise<Outcome<Page>> {
    const key = sha(`page|${canonicalUrl(url)}`);
    const maxAge = opts.fresh ? FRESH_MS.fast : FRESH_MS[opts.volatility];
    const cached = deps.cache.get(key);
    if (cached && now() - cached.fetchedAt < maxAge) {
      return { ok: true, value: { ...JSON.parse(cached.body), fetchedAt: cached.fetchedAt }, cached: true, provider: 'cache' };
    }

    const errors: string[] = [];
    const attempts: [string, () => Promise<{ title: string; text: string }>][] = [];
    if (available('jina')) attempts.push(['jina', () => jinaRead(url, opts.fresh, AbortSignal.any([opts.signal, AbortSignal.timeout(BUDGET.perReadMs)]))]);
    else errors.push('jina: cooling down');
    if (deps.keys.tavily && available('tavily-extract')) {
      attempts.push(['tavily-extract', () => tavilyExtract(url, AbortSignal.any([opts.signal, AbortSignal.timeout(BUDGET.perReadMs)]))]);
    }

    for (const [id, run] of attempts) {
      if (opts.signal.aborted) return { ok: false, error: 'aborted' };
      try {
        const page = await run();
        if (!usable(page.text)) {
          errors.push(`${id}: page was empty or blocked`);
          continue;
        }
        const fetchedAt = now();
        const value = { url, title: page.title, text: page.text, fetchedAt };
        deps.cache.put(key, 'page', JSON.stringify({ url, title: page.title, text: page.text }), maxAge / 1000, fetchedAt);
        return { ok: true, value, cached: false, provider: id };
      } catch (e) {
        if (opts.signal.aborted) return { ok: false, error: 'aborted' };
        if (e instanceof HttpError && [401, 402, 429, 432, 433].includes(e.status)) cool(id, e);
        errors.push(`${id}: ${describe(e)}`);
      }
    }
    return { ok: false, error: errors.join('; ') };
  }

  return {
    search: (queries, opts) => pooled(queries, BUDGET.concurrency, (q) => searchOne(q, opts.signal)),
    read: (urls, opts) => pooled(urls, BUDGET.concurrency, (url) => readOne(url, opts)),
  };
}
