import { extract, selectChunks, terms } from './claims.ts';
import { BUDGET } from './config.ts';
import { dayLabel } from './render.ts';
import { canonicalUrl, domainOf, pooled, type Page, type SearchHit } from './search.ts';
import { lap, say, type Ctx, type Deps, type TurnRequest } from './turn.ts';
import type { Aspect, Entity, EvidenceItem, Intent, Referent, Turn, TurnEvent, VerdictRecord } from './types.ts';
import {
  diff, planChecks, renderDelta, sourceUrl, tier0, validate, validateNews, verify, type CheckedClaim, type NewsItem,
} from './verify.ts';

const NEWS_CUE = /\b(shipped?|ship|releas\w*|launch\w*|announc\w*|news|updat\w*|acquir\w*|something big|anything new|what'?s new|new (feature|version|plan|product)s?)\b/i;
const ASPECT_WORDS: Record<string, string> = { pricing: 'pricing changes', release: 'new release announcement', feature: 'new features' };

export function scopeEntities(ref: Referent): Entity[] {
  if (!ref.sets.length) return ref.entities;
  const byId = new Map<number, Entity>();
  for (const set of ref.sets) {
    const gone = new Set(set.removedAfter.map((e) => e.id));
    for (const e of [...set.members.filter((m) => !gone.has(m.id)), ...set.addedAfter]) byId.set(e.id, e);
  }
  return [...byId.values()];
}

async function backfill(deps: Deps, turn: Turn, signal?: AbortSignal) {
  const evidence: EvidenceItem[] = deps.memory.evidenceFor(turn.id).map((e, i) => ({
    n: i + 1, url: e.url, title: e.title ?? e.url, text: e.chunk, via: e.via, fetchedAt: e.fetchedAt, publishedAt: e.publishedAt ?? undefined,
  }));
  try {
    deps.memory.commitExtraction(turn.id, await extract(deps.llm, { question: turn.userText, answer: turn.answerText ?? '', evidence }, signal, 0));
  } catch (e) {
    deps.log?.(`could not recover claims for turn ${turn.id}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const aspectWords = (focus: Aspect[], wantsNews: boolean) => {
  const words = focus.map((a) => ASPECT_WORDS[a]);
  if (wantsNews && !focus.includes('release')) words.push(ASPECT_WORDS.release);
  return words.length ? words.join(' ') : 'news announcement';
};

export async function* recheck(a: {
  deps: Deps;
  req: TurnRequest;
  ctx: Ctx;
  intent: Intent;
  ref: Referent;
  again: () => Referent;
  now: number;
  tz: string;
  todayLabel: string;
}): AsyncGenerator<TurnEvent> {
  const { deps, req, ctx, intent } = a;
  let ref = a.ref;

  const stale = ref.turns.filter((t) => t.route === 'research' && t.extraction === 'failed' && t.answerText && deps.memory.evidenceFor(t.id).length);
  if (stale.length) {
    yield { type: 'status', text: 'recovering what I recorded earlier' };
    await pooled(stale, 2, (turn) => backfill(deps, turn, req.signal));
    ref = a.again();
  }

  const scope = scopeEntities(ref);
  const names = new Map(scope.map((e) => [e.id, e.name]));
  const baseline = ref.turns.reduce((min, t) => (t.localDate < min ? t.localDate : min), ref.turns[0].localDate);
  const focus = intent.aspects.filter((x): x is 'pricing' | 'release' | 'feature' => x === 'pricing' || x === 'release' || x === 'feature');
  const everything = deps.memory.activeClaims(req.userId, scope.map((e) => e.id));
  const claims = focus.length ? everything.filter((c) => focus.includes(c.aspect as never)) : everything;

  if (!claims.length) {
    yield* say(ctx, `I can't re-check that: I didn't record any sourced facts from ${dayLabel(baseline)}. Ask me again and I'll look it up fresh.`);
    return;
  }

  const plan = planChecks(claims, a.now, BUDGET.reads);
  const wantsNews = NEWS_CUE.test(req.text) || intent.aspects.includes('release');
  const gather = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(BUDGET.softDeadlineMs)]) : AbortSignal.timeout(BUDGET.softDeadlineMs);
  const searchFor = (entities: Entity[]) =>
    entities.length
      ? deps.web.search(entities.map((e) => ({ q: `${e.name} ${aspectWords(focus, wantsNews)}`, since: baseline, volatility: 'fast' as const })), { signal: gather })
      : Promise.resolve([]);

  const newsEntities = wantsNews ? scope.slice(0, BUDGET.searches) : [];
  if (plan.urls.length) yield { type: 'status', text: `re-reading ${plan.urls.length} ${plan.urls.length === 1 ? 'page' : 'pages'}` };
  if (newsEntities.length) yield { type: 'status', text: `looking for news on ${newsEntities.length} ${newsEntities.length === 1 ? 'name' : 'names'}` };

  let t0 = performance.now();
  const [reads, newsFound] = await Promise.all([
    Promise.all(plan.urls.map(async (url) => (await deps.web.read([url], { fresh: true, volatility: 'fast', signal: gather }))[0])),
    searchFor(newsEntities),
  ]);
  lap(ctx, 'fetch', t0);

  const pages = new Map<string, Page>();
  reads.forEach((r, i) => {
    if (r.ok) pages.set(canonicalUrl(plan.urls[i]), { ...r.value, url: plan.urls[i] });
  });

  const first = tier0(plan.pending, pages);
  const checked: CheckedClaim[] = [...plan.settled, ...first.checked];
  const rest = first.rest;

  const hits = new Map<number, SearchHit[]>();
  const newsStatus = { searched: [] as string[], failed: [] as string[] };
  newsEntities.forEach((e, i) => {
    const r = newsFound[i];
    if (r?.ok) {
      hits.set(e.id, r.value);
      newsStatus.searched.push(e.name);
    } else {
      newsStatus.failed.push(e.name);
    }
  });

  const unreadable = scope.filter((e) => !hits.has(e.id) && rest.some((c) => c.entityId === e.id && !pages.has(canonicalUrl(sourceUrl(c)!)))).slice(0, Math.max(0, BUDGET.searches - newsEntities.length));
  if (unreadable.length) {
    const extra = await searchFor(unreadable);
    unreadable.forEach((e, i) => {
      const r = extra[i];
      if (r?.ok) hits.set(e.id, r.value);
    });
  }

  const evidence: EvidenceItem[] = [];
  const addEvidence = (e: Omit<EvidenceItem, 'n'>) => evidence.push({ ...e, n: evidence.length + 1 });
  const maxChars = Math.floor(Math.min(BUDGET.evidenceTokens, deps.llm.maxInputTokens('structure') * 0.5) * 3.5);

  const readable = [...new Set(rest.map((c) => canonicalUrl(sourceUrl(c)!)).filter((u) => pages.has(u)))];
  for (const key of readable) {
    const page = pages.get(key)!;
    const mine = rest.filter((c) => canonicalUrl(sourceUrl(c)!) === key);
    const termList = terms(...mine.map((c) => c.statement), ...mine.map((c) => names.get(c.entityId ?? -1) ?? ''));
    const chunks = selectChunks([page], termList, mine.some((c) => c.aspect === 'pricing') ? 'pricing' : undefined, {
      perPage: 3, total: 4, maxChars: Math.floor(maxChars / readable.length),
    });
    for (const c of chunks) addEvidence({ url: page.url, title: page.title, text: c.text, via: 'page', fetchedAt: page.fetchedAt });
  }
  let used = evidence.reduce((n, e) => n + e.text.length, 0);
  for (const list of hits.values()) {
    for (const hit of list.slice(0, 3)) {
      const text = `${hit.publishedAt ? `[published ${new Date(hit.publishedAt).toISOString().slice(0, 10)}] ` : ''}${hit.title}. ${hit.snippet}`.slice(0, 600);
      if (hit.snippet.trim().length < 40 || used + text.length > maxChars * 2) continue;
      used += text.length;
      addEvidence({ url: hit.url, title: hit.title, text, via: 'snippet', fetchedAt: a.now, publishedAt: hit.publishedAt });
    }
  }

  const haveNewsEvidence = wantsNews && evidence.some((e) => e.via === 'snippet');
  let news: NewsItem[] = [];
  let modelDown = false;
  if (rest.length || haveNewsEvidence) {
    yield { type: 'status', text: 'checking what changed' };
    t0 = performance.now();
    try {
      const out = await verify(deps.llm, {
        claims: rest, names, entities: newsEntities.map((e) => e.name), evidence, since: baseline, today: a.todayLabel, tz: a.tz, wantNews: haveNewsEvidence,
      }, req.signal);
      checked.push(...validate(out, rest, evidence));
      news = validateNews(out, evidence, baseline);
    } catch (e) {
      if (req.signal?.aborted) throw e;
      modelDown = true;
      deps.log?.(`could not verify: ${e instanceof Error ? e.message : String(e)}`);
      checked.push(...rest.map((claim): CheckedClaim => ({ claim, verdict: 'unconfirmed', via: 'model', note: 'the free model providers are over their limits right now' })));
    }
    lap(ctx, 'verify', t0);
  }

  for (const c of checked) {
    if (c.verdict === 'unconfirmed' && c.via === 'model' && !modelDown && !pages.has(canonicalUrl(sourceUrl(c.claim)!))) c.note = 'the source page would not load';
  }

  const records: VerdictRecord[] = checked
    .filter((c) => c.via === 'fresh-page' || c.via === 'model')
    .map((c) => ({ claimId: c.claim.id, verdict: c.verdict, evidence: c.evidence, quote: c.quote, currentValue: c.currentValue, newStatement: c.newStatement }));
  try {
    deps.memory.recordVerdicts(ctx.turnId, deps.clock.now(), records);
  } catch (e) {
    deps.log?.(`could not save the check results: ${e instanceof Error ? e.message : String(e)}`);
  }

  const numbered = new Map<string, number>();
  const titles = new Map<string, { title: string; at: number }>();
  const number = (url: string, title: string, at: number) => {
    const key = canonicalUrl(url);
    if (!numbered.has(key)) {
      numbered.set(key, numbered.size + 1);
      titles.set(key, { title, at });
    }
  };
  for (const c of checked) if (c.url && (c.verdict === 'unchanged' || c.verdict === 'changed')) number(c.url, c.evidence?.title ?? domainOf(c.url), c.evidence?.fetchedAt ?? a.now);
  for (const n of news) number(n.url, domainOf(n.url), a.now);
  const cite = (url: string | undefined) => (url && numbered.has(canonicalUrl(url)) ? ` [${numbered.get(canonicalUrl(url))}]` : '');

  const groups = scope.map((e) => ({ id: e.id as number | null, name: e.name }));
  if (claims.some((c) => c.entityId == null)) groups.push({ id: null, name: 'This answer' });
  const withBaseline = groups.filter((g) => claims.some((c) => (c.entityId ?? null) === g.id));
  const text = renderDelta(diff(withBaseline, checked, news), {
    baseline: dayLabel(baseline),
    today: a.todayLabel,
    cite,
    noBaseline: ref.sets.length ? groups.filter((g) => !withBaseline.includes(g)).map((g) => g.name) : [],
    news: newsStatus,
  });

  yield* say(ctx, text);
  yield {
    type: 'sources',
    items: [...numbered].map(([url, n]) => ({ n, url, title: titles.get(url)!.title, checkedAt: titles.get(url)!.at })),
  };
}
