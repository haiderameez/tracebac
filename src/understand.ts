import { z } from 'zod';
import type { LLM } from './llm.ts';
import { routerMessages } from './prompts.ts';
import type { Aspect, Intent, TimeRef, Turn } from './types.ts';

const optionalText = z.string().nullish().transform((v) => v?.trim() || undefined);
const list = <T extends z.ZodType>(item: T) => z.array(item).nullish().transform((v) => v ?? []);

const TimeRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('absolute'),
    day: z.number().int().min(1).max(31),
    month: z.number().int().min(1).max(12),
    year: z.number().int().nullish().transform((v) => v ?? undefined),
  }),
  z.object({
    kind: z.literal('weekday'),
    weekday: z.number().int().min(1).max(7),
    modifier: z.enum(['bare', 'last', 'this']),
  }),
  z.object({
    kind: z.literal('relative'),
    unit: z.enum(['day', 'week', 'month']),
    n: z.number().int().min(0),
  }),
  z.object({ kind: z.literal('vague') }),
]);

const ASPECTS: Aspect[] = ['pricing', 'release', 'feature', 'fact', 'other'];

export const IntentSchema = z.object({
  route: z.enum(['chat', 'recall', 'recheck', 'research', 'clarify']),
  reply: optionalText,
  topic: z.string().nullish().transform((v) => v?.trim() ?? ''),
  refersToPast: z.boolean().nullish().transform((v) => v ?? false),
  timeRefs: list(z.unknown()).transform((refs) =>
    refs.flatMap((r) => {
      const parsed = TimeRefSchema.safeParse(r);
      return parsed.success ? [parsed.data as TimeRef] : [];
    }),
  ),
  topicHint: optionalText,
  entityRefs: list(z.string()),
  aspects: list(z.string()).transform((xs) => xs.filter((x): x is Aspect => ASPECTS.includes(x as Aspect))),
  queries: list(z.string()).transform((xs) => xs.map((x) => x.trim()).filter(Boolean)),
});

const SMALL_TALK = new Set([
  'hi', 'hey', 'hello', 'hiya', 'yo', 'sup', 'thanks', 'thank', 'you', 'thx', 'ty', 'ok', 'okay', 'cool', 'great', 'nice',
  'got', 'it', 'bye', 'goodbye', 'lol', 'there', 'so', 'much', 'a', 'lot', 'again', 'good', 'morning', 'afternoon', 'evening',
  'night', 'perfect', 'awesome', 'np',
]);

const FRESHNESS = /\b(still|changed?|since|current(ly)?|latest|anymore|any more|up to date|updated?|different|correct|true|valid|accurate|outdated)\b/i;

export function isTrivial(message: string): boolean {
  const words = message.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 5 && words.every((w) => SMALL_TALK.has(w));
}

function smallTalkReply(message: string): string {
  if (/\b(thanks|thank|thx|ty)\b/i.test(message)) return 'Anytime.';
  if (/\b(bye|goodbye|night)\b/i.test(message)) return 'Bye.';
  return 'Hey, what are we looking into?';
}

const GENERIC_HINT = new Set([
  'question', 'questions', 'ask', 'asked', 'asking', 'conversation', 'conversations', 'chat', 'chats', 'talk', 'talked',
  'said', 'earlier', 'today', 'yesterday', 'before', 'last', 'thing', 'things', 'stuff', 'anything', 'message', 'messages', 'me', 'you', 'we', 'our', 'my', 's',
]);

const isGenericHint = (hint: string) => (hint.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).every((w) => GENERIC_HINT.has(w));

export function applyGuards(intent: Intent, message: string): Intent {
  const out: Intent = { ...intent, queries: intent.queries.slice(0, 4) };
  if (out.topicHint && isGenericHint(out.topicHint)) out.topicHint = undefined;

  if ((out.refersToPast || out.timeRefs.length) && (out.route === 'research' || out.route === 'chat')) out.route = 'recall';
  if (out.route === 'recall' && FRESHNESS.test(message)) out.route = 'recheck';

  if (out.route === 'chat' && !out.reply) out.route = 'research';
  if (out.route === 'clarify' && !out.reply) out.reply = "Can you say a bit more about what you're after?";
  if (out.route === 'research' && !out.queries.length) out.queries = [message];
  return out;
}

const fallbackIntent = (message: string): Intent => ({
  route: 'research',
  topic: message.slice(0, 60),
  refersToPast: false,
  timeRefs: [],
  entityRefs: [],
  aspects: [],
  queries: [message],
});

export interface UnderstandInput {
  message: string;
  recent: Turn[];
  threadIndex: string[];
  today: { date: string; dow: number };
  tz: string;
}

export interface Understood {
  intent: Intent;
  degraded: boolean;
  error?: string;
}

export async function understand(llm: LLM, input: UnderstandInput, signal?: AbortSignal): Promise<Understood> {
  if (isTrivial(input.message)) {
    const intent: Intent = { ...fallbackIntent(input.message), route: 'chat', reply: smallTalkReply(input.message), topic: 'small talk', queries: [] };
    return { intent, degraded: false };
  }

  const result = await llm.object('route', routerMessages(input), IntentSchema, { signal });
  if (!result.ok) return { intent: applyGuards(fallbackIntent(input.message), input.message), degraded: true, error: result.error };
  return { intent: applyGuards(result.value, input.message), degraded: false };
}
