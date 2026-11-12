import { BUDGET } from './config.ts';
import { selectChunks, terms } from './claims.ts';
import { Exhausted, StreamInterrupted } from './llm.ts';
import { synthMessages } from './prompts.ts';
import { renderSources } from './render.ts';
import { createSanitizer } from './sanitize.ts';
import { addDays, localDay } from './time.ts';
import { canonicalUrl, domainOf, type Outcome, type Page, type SearchHit, type SearchQuery } from './search.ts';
import { lap, say, type Ctx, type Deps, type TurnRequest } from './turn.ts';
import type { Aspect, EvidenceItem, Intent, Turn, TurnEvent, Volatility } from './types.ts';

export function volatilityOf(aspects: Aspect[], current = false): Volatility {
  if (current || !aspects.length || aspects.includes('pricing') || aspects.includes('release')) return 'fast';
  return 'slow';
}

const POOR_SOURCES = /(^|\.)(youtube\.com|youtu\.be|instagram\.com|tiktok\.com|facebook\.com|pinterest\.com|x\.com|twitter\.com)$/;

export function pickPages(perQuery: SearchHit[][], limit: number, perDomain = 2): SearchHit[] {
  const seen = new Set<string>();
  const domains = new Map<string, number>();
  const picked: SearchHit[] = [];
  const depth = Math.max(0, ...perQuery.map((hits) => hits.length));

  for (const poor of [false, true]) {
    for (let rank = 0; rank < depth && picked.length < limit; rank++) {
      for (const hits of perQuery) {
        const hit = hits[rank];
        if (!hit || picked.length >= limit || POOR_SOURCES.test(domainOf(hit.url)) !== poor) continue;
        const url = canonicalUrl(hit.url);
        const domain = domainOf(hit.url);
        if (seen.has(url) || (domains.get(domain) ?? 0) >= perDomain) continue;
        seen.add(url);
        domains.set(domain, (domains.get(domain) ?? 0) + 1);
        picked.push(hit);
      }
    }
  }
  return picked;
}

export function planQueries(intent: Pick<Intent, 'queries' | 'current' | 'aspects'>, today: string): SearchQuery[] {
  const volatility = volatilityOf(intent.aspects, intent.current);
  const base = intent.queries.slice(0, BUDGET.searches).map((q) => ({ q, volatility }));
  if (!intent.current) return base;
  const since = addDays(today, -BUDGET.freshDays);
  const recent = base.slice(0, Math.min(BUDGET.freshVariants, BUDGET.searches - base.length)).map((q) => ({ ...q, since, news: true }));
  return [...base, ...recent];
}

const simplify =(q: string) => q.replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();

export function readEarly(
  urls: string[],
  read: (url: string, signal: AbortSignal) => Promise<Outcome<Page>>,
  parent: AbortSignal,
  want: number,
  graceMs: number,
): Promise<Outcome<Page>[]> {
  const ctl = new AbortController();
  const signal = AbortSignal.any([parent, ctl.signal]);
  const results = new Array<Outcome<Page> | undefined>(urls.length);

  return new Promise((resolve) => {
    let pending = urls.length;
    let succeeded = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      clearTimeout(timer);
      ctl.abort();
      resolve(urls.map((_, i) => results[i] ?? { ok: false, error: 'not finished in time' }));
    };

    if (!urls.length) return finish();
    urls.forEach((url, i) => {
      read(url, signal)
        .then((outcome) => {
          results[i] = outcome;
          if (outcome.ok && ++succeeded === want) timer = setTimeout(finish, graceMs);
        })
        .catch((e) => {
          results[i] = { ok: false, error: e instanceof Error ? e.message : String(e) };
        })
        .finally(() => {
          if (--pending === 0) finish();
        });
    });
  });
}

export async function* research(a: {
  deps: Deps;
  req: TurnRequest;
  ctx: Ctx;
  intent: Intent;
  recent: Turn[];
  todayLabel: string;
  tz: string;
}): AsyncGenerator<TurnEvent> {
  const { deps, req, ctx, intent } = a;
  const volatility = volatilityOf(intent.aspects, intent.current);
  const queries = planQueries(intent, localDay(deps.clock.now(), a.tz).date);
  const asked = Math.min(intent.queries.length, BUDGET.searches);
  const gather = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(BUDGET.softDeadlineMs)]) : AbortSignal.timeout(BUDGET.softDeadlineMs);

  yield { type: 'status', text: asked === 1 ? `searching: ${intent.queries[0]}` : `searching ${asked} queries` };
  let t0 = performance.now();
  const results = await deps.web.search(queries, { signal: gather });

  const retry = results.flatMap((r, i) => (r.ok && !r.value.length && simplify(queries[i].q) !== queries[i].q ? [i] : []));
  const room = Math.max(0, BUDGET.searches - queries.length);
  if (retry.length && room) {
    const again = retry.slice(0, room);
    const redone = await deps.web.search(again.map((i) => ({ ...queries[i], q: simplify(queries[i].q) })), { signal: gather });
    again.forEach((i, k) => (results[i] = redone[k]));
  }
  lap(ctx, 'search', t0);

  const failed = results.flatMap((r, i) => (r.ok ? [] : [queries[i].q]));
  if (results.every((r) => !r.ok)) {
    const why = results.find((r) => !r.ok && r.error !== 'aborted');
    yield* say(ctx, `I couldn't reach a search provider right now${why && !why.ok ? ` (${why.error.slice(0, 120)})` : ''}. Try again in a moment.`);
    return;
  }

  const perQuery = results.map((r) => (r.ok ? [...r.value].sort((x, y) => y.score - x.score) : []));
  const chosen = pickPages(perQuery, BUDGET.reads);
  if (!chosen.length) {
    yield* say(ctx, `I searched for ${queries.map((q) => `"${q.q}"`).join(', ')} and found nothing usable.`);
    return;
  }

  yield { type: 'status', text: `reading ${chosen.length} ${chosen.length === 1 ? 'page' : 'pages'}` };
  t0 = performance.now();
  const reads = await readEarly(
    chosen.map((h) => h.url),
    async (url, signal) => (await deps.web.read([url], { fresh: false, volatility, signal }))[0],
    gather,
    BUDGET.readWant,
    BUDGET.readGraceMs,
  );
  lap(ctx, 'read', t0);

  const pages = reads.flatMap((r, i) => (r.ok ? [{ url: chosen[i].url, title: r.value.title || chosen[i].title, text: r.value.text, fetchedAt: r.value.fetchedAt }] : []));
  const published = new Map(reads.flatMap((r, i) => { const at = (r.ok && r.value.publishedAt) || chosen[i].publishedAt; return at ? [[chosen[i].url, at] as const] : []; }));
  const maxChars = Math.floor(Math.min(BUDGET.evidenceTokens, deps.llm.maxInputTokens('write') * 0.55) * 3.5);
  const chunks = selectChunks(pages, terms(...queries.map((q) => q.q), ...intent.entityRefs), intent.aspects.includes('pricing') ? 'pricing' : undefined, {
    perPage: Math.max(4, Math.ceil(BUDGET.maxChunks / Math.max(1, pages.length))), total: BUDGET.maxChunks, maxChars,
  });

  const fetchedAt = new Map(pages.map((p) => [p.url, p.fetchedAt]));
  const evidence: EvidenceItem[] = chunks.map((c, i) => ({ n: i + 1, url: c.url, title: c.title, text: c.text, via: 'page', fetchedAt: fetchedAt.get(c.url) ?? deps.clock.now(), publishedAt: published.get(c.url) }));

  let used = evidence.reduce((n, e) => n + e.text.length, 0);
  const covered = new Set(evidence.map((e) => canonicalUrl(e.url)));
  for (const hit of chosen) {
    const snippet = hit.snippet.trim().slice(0, 500);
    if (covered.has(canonicalUrl(hit.url)) || snippet.length < 40 || used + snippet.length > maxChars) continue;
    covered.add(canonicalUrl(hit.url));
    used += snippet.length;
    evidence.push({ n: evidence.length + 1, url: hit.url, title: hit.title, text: snippet, via: 'snippet', fetchedAt: deps.clock.now(), publishedAt: hit.publishedAt });
  }

  if (!evidence.length) {
    yield* say(ctx, `I found pages for ${queries.map((q) => `"${q.q}"`).join(', ')} but couldn't read anything useful from them.`);
    return;
  }

  const question = intent.standalone ?? req.text;
  ctx.research = { question, evidence };
  yield { type: 'status', text: 'writing' };
  t0 = performance.now();

  const sanitizer = createSanitizer(evidence.map((e) => e.url), evidence.length);
  let wrote = false;
  try {
    const messages = synthMessages({ question, asked: req.text, recent: a.recent, evidence, gaps: failed, today: a.todayLabel, tz: a.tz });
    for await (const delta of deps.llm.stream('write', messages, { signal: req.signal, maxWaitMs: BUDGET.writeWaitMs })) {
      const text = sanitizer.push(delta);
      if (text) {
        wrote = true;
        yield* say(ctx, text);
      }
    }
    const tail = sanitizer.flush();
    if (tail) {
      wrote = true;
      yield* say(ctx, tail);
    }
  } catch (e) {
    const tail = sanitizer.flush();
    if (tail) yield* say(ctx, tail);
    if (e instanceof StreamInterrupted) yield* say(ctx, '\n\n(the connection to the model dropped, so that answer is cut short)');
    else if (req.signal?.aborted || !(e instanceof Exhausted)) throw e;
  }
  if (!wrote) yield* say(ctx, renderSources(evidence));
  lap(ctx, 'write', t0);

  const cited = new Set(sanitizer.cited());
  const shown = evidence.filter((e) => !cited.size || cited.has(e.n)).slice(0, 8);
  yield { type: 'sources', items: shown.map((e) => ({ n: e.n, url: e.url, title: e.title, checkedAt: e.fetchedAt, publishedAt: e.publishedAt })) };
}
