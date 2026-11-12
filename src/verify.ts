import { z } from 'zod';
import { ledgerEvidence, lenient, optional } from './claims.ts';
import { FRESH_MS } from './config.ts';
import type { LLM } from './llm.ts';
import { verifyMessages } from './prompts.ts';
import { dayLabel } from './render.ts';
import { canonicalUrl, type Page } from './search.ts';
import { canon } from './text.ts';
import type { Claim, EvidenceItem, Extraction, Verdict } from './types.ts';

export interface CheckedClaim {
  claim: Claim;
  verdict: Verdict;
  via: 'fresh-page' | 'model' | 'recent' | 'skipped';
  note?: string;
  currentValue?: string;
  newStatement?: string;
  url?: string;
  evidence?: Extraction['evidence'][number];
  quote?: string;
}

export interface NewsItem {
  entity: string;
  headline: string;
  date?: string;
  url: string;
  quote: string;
}

export interface Plan {
  urls: string[];
  settled: CheckedClaim[];
  pending: Claim[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function locate(text: string, quote: string): { start: number; end: number } | null {
  const words = quote.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const match = new RegExp(words.map(escapeRe).join('\\s+'), 'i').exec(text);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

const excerpt = (text: string, at: { start: number; end: number }) => text.slice(Math.max(0, at.start - 250), Math.min(text.length, at.end + 250)).trim();

export const sourceUrl = (claim: Claim) => claim.sources.find((s) => s.stance === 'supports')?.evidence.url;

export function planChecks(claims: Claim[], now: number, maxReads: number): Plan {
  const settled: CheckedClaim[] = [];
  const candidates: Claim[] = [];

  for (const claim of claims) {
    if (claim.status === 'unverifiable' || !sourceUrl(claim)) {
      settled.push({ claim, verdict: 'unconfirmed', via: 'skipped', note: 'no source was recorded for it' });
    } else if (claim.volatility === 'static') {
      settled.push({ claim, verdict: 'unconfirmed', via: 'skipped', note: 'a static fact, not re-checked' });
    } else if (claim.lastVerdict === 'unchanged' && claim.lastCheckedAt && now - claim.lastCheckedAt < FRESH_MS[claim.volatility]) {
      const minutes = Math.max(1, Math.round((now - claim.lastCheckedAt) / 60000));
      settled.push({ claim, verdict: 'unchanged', via: 'recent', note: `checked ${minutes} min ago` });
    } else {
      candidates.push(claim);
    }
  }

  const rank = { fast: 0, slow: 1, static: 2 };
  candidates.sort((a, b) => rank[a.volatility] - rank[b.volatility] || (a.lastCheckedAt ?? 0) - (b.lastCheckedAt ?? 0));

  const urls: string[] = [];
  const pending: Claim[] = [];
  for (const claim of candidates) {
    const url = sourceUrl(claim)!;
    if (!urls.some((u) => canonicalUrl(u) === canonicalUrl(url))) {
      if (urls.length >= maxReads) {
        settled.push({ claim, verdict: 'unconfirmed', via: 'skipped', note: 'not checked, over the limit for one answer' });
        continue;
      }
      urls.push(url);
    }
    pending.push(claim);
  }
  return { urls, settled, pending };
}

export function tier0(pending: Claim[], pages: Map<string, Page>): { checked: CheckedClaim[]; rest: Claim[] } {
  const checked: CheckedClaim[] = [];
  const rest: Claim[] = [];

  for (const claim of pending) {
    const page = pages.get(canonicalUrl(sourceUrl(claim)!));
    const pageText = page ? canon(page.text) : '';
    const quote = page ? claim.sources.filter((s) => s.stance === 'supports').map((s) => s.quote).find((q) => pageText.includes(canon(q))) : undefined;
    if (!page || !quote) {
      rest.push(claim);
      continue;
    }
    const at = locate(page.text, quote);
    checked.push({
      claim, verdict: 'unchanged', via: 'fresh-page', url: page.url, quote: at ? quote : undefined,
      evidence: { key: '', url: page.url, title: page.title, chunk: at ? excerpt(page.text, at) : page.text.slice(0, 600), fetchedAt: page.fetchedAt, via: 'page' },
    });
  }
  return { checked, rest };
}

const reference = z.union([z.number(), z.string()]).nullish();

export const VerifySchema = z.object({
  verdicts: lenient(z.object({
    claimId: z.number(), verdict: z.string(), currentValue: optional, newStatement: optional, evidence: reference, quote: optional, note: optional,
  })),
  news: lenient(z.object({ entity: z.string(), headline: z.string().min(1), date: optional, evidence: reference, quote: optional })),
});

export type VerifyOutput = z.output<typeof VerifySchema>;

export interface VerifyInput {
  claims: Claim[];
  names: Map<number, string>;
  entities: string[];
  evidence: EvidenceItem[];
  since: string;
  today: string;
  tz: string;
  wantNews: boolean;
}

export async function verify(llm: LLM, input: VerifyInput, signal?: AbortSignal): Promise<VerifyOutput> {
  const result = await llm.object('structure', verifyMessages(input), VerifySchema, { signal });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

const findEvidence = (evidence: EvidenceItem[], ref: string | number | null | undefined) => evidence.find((e) => String(e.n) === String(ref));
const quotedIn = (ev: EvidenceItem | undefined, quote: string | undefined) => !!ev && !!quote && canon(ev.text).includes(canon(quote));

export function validate(out: VerifyOutput, rest: Claim[], evidence: EvidenceItem[]): CheckedClaim[] {
  return rest.map((claim): CheckedClaim => {
    const v = out.verdicts.find((x) => x.claimId === claim.id);
    if (!v) return { claim, verdict: 'unconfirmed', via: 'model', note: 'the model gave no answer for it' };

    const ev = findEvidence(evidence, v.evidence);
    const quoted = quotedIn(ev, v.quote);
    const proof = ev ? { url: ev.url, evidence: ledgerEvidence([ev])[0], quote: quoted ? v.quote : undefined } : {};
    const verdict = v.verdict.toLowerCase();

    if (verdict === 'unchanged' && quoted) return { claim, verdict: 'unchanged', via: 'model', ...proof };
    if (verdict === 'changed' && quoted && v.currentValue && canon(ev!.text).includes(canon(v.currentValue)) && canon(v.currentValue) !== canon(claim.value ?? '')) {
      return {
        claim, verdict: 'changed', via: 'model', currentValue: v.currentValue,
        newStatement: v.newStatement ?? `${claim.statement} (now ${v.currentValue})`, ...proof,
      };
    }
    const note = verdict === 'unconfirmed' ? v.note ?? 'the pages I read do not cover it' : 'I could not back that up with a quote from the page';
    return { claim, verdict: 'unconfirmed', via: 'model', note };
  });
}

export function validateNews(out: VerifyOutput, evidence: EvidenceItem[], since: string): NewsItem[] {
  const seen = new Set<string>();
  const items: NewsItem[] = [];
  for (const n of out.news) {
    const ev = findEvidence(evidence, n.evidence);
    if (!ev || !n.quote || !quotedIn(ev, n.quote)) continue;
    const date = n.date && /^\d{4}-\d{2}-\d{2}$/.test(n.date) ? n.date : undefined;
    if (date && date < since) continue;
    const key = canon(n.headline);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ entity: n.entity, headline: n.headline, date, url: ev.url, quote: n.quote });
  }
  return items;
}

export interface EntityDelta {
  name: string;
  changes: CheckedClaim[];
  news: NewsItem[];
  unchanged: CheckedClaim[];
  unconfirmed: CheckedClaim[];
  notChecked: CheckedClaim[];
}

export type EntityStatus = 'changed' | 'news' | 'unconfirmed' | 'unchanged' | 'not_checked';

export function statusOf(e: EntityDelta): EntityStatus {
  if (e.changes.length) return 'changed';
  if (e.news.length) return 'news';
  if (e.unconfirmed.length) return 'unconfirmed';
  if (e.unchanged.length) return 'unchanged';
  return 'not_checked';
}

export function diff(entities: { id: number | null; name: string }[], checked: CheckedClaim[], news: NewsItem[]): EntityDelta[] {
  return entities.map(({ id, name }) => {
    const mine = checked.filter((c) => (c.claim.entityId ?? null) === id);
    const pick = (f: (c: CheckedClaim) => boolean) => mine.filter(f);
    return {
      name,
      changes: pick((c) => c.verdict === 'changed'),
      news: news.filter((n) => canon(n.entity) === canon(name)),
      unchanged: pick((c) => c.verdict === 'unchanged'),
      unconfirmed: pick((c) => c.verdict !== 'changed' && c.verdict !== 'unchanged' && c.via !== 'skipped'),
      notChecked: pick((c) => c.via === 'skipped' && c.verdict !== 'unchanged'),
    };
  });
}

const listOf = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]);

const ASPECT_NOUN: Record<string, string> = { pricing: 'price', release: 'release', feature: 'feature' };

export function renderDelta(
  deltas: EntityDelta[],
  ctx: { baseline: string; today: string; cite: (url: string | undefined) => string; noBaseline: string[]; news: { searched: string[]; failed: string[] } },
): string {
  const by = (s: EntityStatus) => deltas.filter((d) => statusOf(d) === s);
  const total = deltas.length;
  const changed = by('changed').length;
  const news = by('news').length;
  const unconfirmed = by('unconfirmed').length;
  const unchanged = by('unchanged');

  const parts = [
    changed && `${changed} of ${total} changed`,
    news && `${news} ${news === 1 ? 'has' : 'have'} news`,
    unconfirmed && `${unconfirmed} I couldn't confirm`,
  ].filter(Boolean);
  const everyoneSame = !parts.length && unchanged.length === total && total > 0;
  const headline = everyoneSame
    ? `**Nothing changed.** ${total === 1 ? 'It still matches' : total === 2 ? 'Both still match' : `All ${total} still match`} what I recorded on ${ctx.baseline}.`
    : parts.length
      ? `**${parts.join(', ')}.**`
      : unchanged.length
        ? `**Nothing changed in the ${unchanged.length} I could check.**`
        : `**I couldn't re-check anything from ${ctx.baseline}.**`;

  const lines: string[] = [headline, ''];

  for (const d of by('changed')) {
    for (const c of d.changes) {
      const was = c.claim.value ?? c.claim.statement;
      lines.push(`- **${d.name}**: ${ASPECT_NOUN[c.claim.aspect] ?? 'detail'} changed, ${was} → ${c.currentValue ?? c.newStatement}${ctx.cite(c.url)}.`);
    }
  }
  for (const d of deltas) {
    for (const n of d.news) {
      lines.push(`- **${d.name}**: new, ${n.headline} (${n.date ? dayLabel(n.date) : 'date not confirmed'})${ctx.cite(n.url)}.`);
    }
  }
  if (unchanged.length) {
    const cites = [...new Set(unchanged.flatMap((d) => d.unchanged.map((c) => ctx.cite(c.url))))].join('');
    const recent = unchanged.every((d) => d.unchanged.every((c) => c.via === 'recent')) ? ` (${unchanged[0].unchanged[0].note})` : '';
    lines.push(`- **${everyoneSame ? 'Re-checked' : 'No change'}:** ${unchanged.map((d) => d.name).join(', ')}${cites}${recent}.`);
  }
  for (const d of by('unconfirmed')) {
    const why = d.unconfirmed[0]?.note ?? 'the pages I found did not settle it';
    lines.push(`- **${d.name}**: couldn't confirm, ${why}. Last recorded: ${d.unconfirmed[0].claim.value ?? d.unconfirmed[0].claim.statement}.`);
  }
  if (ctx.news.searched.length && !deltas.some((d) => d.news.length)) lines.push(`- Looked for news on ${listOf(ctx.news.searched)}: nothing since ${ctx.baseline}.`);
  if (ctx.news.failed.length) lines.push(`- Couldn't search for news on ${listOf(ctx.news.failed)} right now.`);

  const skipped = new Map<string, number>();
  for (const d of deltas) for (const c of d.notChecked) skipped.set(`${d.name} (${c.note})`, (skipped.get(`${d.name} (${c.note})`) ?? 0) + 1);
  if (skipped.size) lines.push(`- Not re-checked: ${[...skipped].map(([what, n]) => (n > 1 ? `${what} ×${n}` : what)).join('; ')}.`);
  if (ctx.noBaseline.length) lines.push(`- No earlier record to compare for ${ctx.noBaseline.join(', ')}.`);

  lines.push('', `Checked live on ${ctx.today}, against what I recorded on ${ctx.baseline}.`);
  return lines.filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}
