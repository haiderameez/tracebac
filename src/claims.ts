import { z } from 'zod';
import { BUDGET } from './config.ts';
import type { LLM } from './llm.ts';
import { extractMessages } from './prompts.ts';
import type { Aspect, EvidenceItem, Extraction, Volatility } from './types.ts';

const BACKGROUND_RESERVE = 2;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'has', 'have', 'had', 'what', 'which', 'who', 'how', 'does', 'did', 'with', 'from', 'that',
  'this', 'about', 'into', 'than', 'then', 'them', 'they', 'its', 'any', 'all', 'can', 'you', 'your', 'our', 'not', 'but', 'per', 'vs',
]);

const PRICE = /[$€£]\s?\d|\b\d+(\.\d+)?\s?(\/|per\s)\s?(mo|month|user|seat|year|yr|gb|hour|hr)\b/gi;

const RATING = /\b(?:10|\d)(?:\.\d)?\s*\/\s*10\b|\b\d\.\d\b/g;
const RATING_WORDS = /^(rating|ratings|rated|score|scores|rank|ranked|ranking|rankings|review|reviews)$/;

export function terms(...texts: string[]): string[] {
  const out = new Set<string>();
  for (const text of texts) {
    for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      if (word.length >= 3 && !STOPWORDS.has(word)) out.add(word);
    }
  }
  return [...out];
}

export function chunkText(text: string, max: number = BUDGET.chunkChars): string[] {
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current.length >= 30) chunks.push(current);
    current = '';
  };
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (line.length > max) {
      flush();
      for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
    } else if (current.length + line.length + 1 > max) {
      flush();
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  flush();
  return chunks;
}

export interface Chunk {
  url: string;
  title: string;
  text: string;
  score: number;
}

export function scoreChunk(text: string, termList: string[], aspect?: Aspect): number {
  const lower = text.toLowerCase();
  const matched = termList.filter((t) => lower.includes(t)).length;
  const overlap = termList.length ? matched / termList.length : 0;
  const prices = aspect === 'pricing' ? (text.match(PRICE) ?? []).length : 0;
  const ratings = termList.some((t) => RATING_WORDS.test(t)) ? (text.match(RATING) ?? []).length : 0;
  const wantsFigures = aspect === 'pricing' || ratings > 0 || termList.some((t) => RATING_WORDS.test(t));
  const score = (wantsFigures ? overlap * 0.5 : overlap) + Math.min(1.5, (prices + ratings) * 0.15);

  const lines = text.split('\n');
  const menuLike = lines.filter((l) => /^[*-]\s/.test(l)).length / lines.length > 0.5 && text.length / lines.length < 45 && prices / lines.length < 0.3;
  return menuLike ? score * 0.5 : score;
}

export function selectChunks(
  pages: { url: string; title: string; text: string }[],
  termList: string[],
  aspect: Aspect | undefined,
  opts: { perPage: number; total: number; maxChars: number },
): Chunk[] {
  type Scored = Chunk & { page: number; order: number };
  const all: Scored[] = pages.flatMap((page, p) =>
    chunkText(page.text).map((text, order) => ({ url: page.url, title: page.title, text, score: scoreChunk(text, termList, aspect), page: p, order })),
  );
  if (!all.length) return [];

  const byScore = [...all].sort((a, b) => b.score - a.score);
  const floor = byScore[0].score * 0.4;
  const chosen = new Set<Scored>();
  const perPage = new Map<number, number>();
  const take = (chunk: Scored) => {
    chosen.add(chunk);
    perPage.set(chunk.page, (perPage.get(chunk.page) ?? 0) + 1);
  };

  for (let p = 0; p < pages.length; p++) {
    const best = byScore.find((c) => c.page === p);
    if (best) take(best);
  }
  const pageOrder = pages.map((_, p) => p).sort((a, b) => (byScore.find((c) => c.page === b)?.score ?? 0) - (byScore.find((c) => c.page === a)?.score ?? 0));
  for (let added = true; added && chosen.size < opts.total; ) {
    added = false;
    for (const p of pageOrder) {
      const next = byScore.find((c) => c.page === p && !chosen.has(c) && c.score >= floor);
      if (!next || (perPage.get(p) ?? 0) >= opts.perPage || chosen.size >= opts.total) continue;
      take(next);
      added = true;
    }
  }

  const kept = [...chosen].sort((a, b) => a.score - b.score);
  const size = () => kept.reduce((n, c) => n + c.text.length, 0);
  while (kept.length > 1 && (kept.length > opts.total || size() > opts.maxChars)) kept.shift();
  if (kept.length === 1 && size() > opts.maxChars) kept[0] = { ...kept[0], text: kept[0].text.slice(0, opts.maxChars) };

  const pageBest = (p: number) => Math.max(0, ...kept.filter((c) => c.page === p).map((c) => c.score));
  return kept
    .sort((a, b) => pageBest(b.page) - pageBest(a.page) || a.page - b.page || a.order - b.order)
    .map(({ page: _page, order: _order, ...chunk }) => chunk);
}

const lenient = <T extends z.ZodType>(schema: T) =>
  z.array(z.unknown()).nullish().transform((items) =>
    (items ?? []).flatMap((item) => {
      const parsed = schema.safeParse(item);
      return parsed.success ? [parsed.data as z.output<T>] : [];
    }),
  );

const optional = z.string().nullish().transform((v) => v?.trim() || undefined);

const EntityIn = z.object({
  name: z.string().min(1),
  kind: optional,
  aliases: z.array(z.string()).nullish().transform((v) => v ?? undefined),
  officialDomain: optional,
});

const ClaimIn = z.object({
  entity: optional,
  aspect: z.string(),
  statement: z.string().min(1),
  value: optional,
  volatility: z.string().nullish(),
  sources: lenient(z.object({ evidence: z.union([z.number(), z.string()]), quote: z.string() })),
});

const SetIn = z.object({ label: z.string().min(1), add: z.array(z.string()).nullish().transform((v) => v ?? []) });

export const ExtractSchema = z.object({
  entities: lenient(EntityIn),
  claims: lenient(ClaimIn),
  sets: lenient(SetIn),
});

function normalizeAspect(raw: string): Aspect {
  const s = raw.toLowerCase();
  if (/pric|cost|plan|fee/.test(s)) return 'pricing';
  if (/releas|launch|version|ship/.test(s)) return 'release';
  if (/feature|capab/.test(s)) return 'feature';
  if (/fact/.test(s)) return 'fact';
  return 'other';
}

function normalizeVolatility(raw: string | null | undefined, aspect: Aspect): Volatility {
  if (raw === 'fast' || raw === 'slow' || raw === 'static') return raw;
  return aspect === 'pricing' || aspect === 'release' ? 'fast' : 'slow';
}

export const ledgerEvidence = (evidence: EvidenceItem[]): Extraction['evidence'] =>
  evidence.map((e) => ({
    key: String(e.n), url: e.url, title: e.title, chunk: e.text, fetchedAt: e.fetchedAt, publishedAt: e.publishedAt, via: e.via,
  }));

export async function extract(
  llm: LLM,
  input: { question: string; answer: string; evidence: EvidenceItem[] },
  signal?: AbortSignal,
): Promise<Extraction> {
  const result = await llm.object('structure', extractMessages(input), ExtractSchema, { signal, reserve: BACKGROUND_RESERVE });
  if (!result.ok) throw new Error(result.error);

  return {
    evidence: ledgerEvidence(input.evidence),
    entities: result.value.entities,
    claims: result.value.claims.map((c) => {
      const aspect = normalizeAspect(c.aspect);
      return {
        entity: c.entity, aspect, statement: c.statement, value: c.value, volatility: normalizeVolatility(c.volatility, aspect),
        sources: c.sources.map((s) => ({ evidence: String(s.evidence), quote: s.quote })),
      };
    }),
    sets: result.value.sets,
  };
}
