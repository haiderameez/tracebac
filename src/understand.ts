import { z } from 'zod';
import { BUDGET } from './config.ts';
import type { LLM } from './llm.ts';
import { routerMessages } from './prompts.ts';
import type { Aspect, Intent, Route, TimeRef, Turn } from './types.ts';

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
  standalone: optionalText,
  current: z.boolean().nullish().transform((v) => v ?? false),
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

export const SMALL_TALK_REPLIES = {
  greeting: [
    'Hey, what are we looking into?',
    'Hi! What can I dig up for you?',
    'Hey there. What do you want to know?',
    "Hello. What's on your mind?",
    "Hey. Ask me anything, I'll look it up.",
    'Hi, what are we researching today?',
  ],
  thanks: ['Anytime.', "You're welcome.", 'Happy to help.', 'No problem.', 'Glad that helped.', 'Sure thing.'],
  ack: ['Got it.', 'Sounds good.', 'Alright.', 'Cool, anything else?', "Okay. Let me know what's next.", 'Great. Ask away whenever.'],
  bye: ['Bye.', 'See you later.', 'Take care.', 'Catch you later.', 'Talk soon.'],
} as const;

type SmallTalk = keyof typeof SMALL_TALK_REPLIES;
const lastPicked = new Map<SmallTalk, number>();

function smallTalkKind(message: string): SmallTalk {
  if (/\b(bye|goodbye|night)\b/i.test(message)) return 'bye';
  if (/\b(thanks|thank|thx|ty)\b/i.test(message)) return 'thanks';
  if (/\b(ok|okay|cool|great|nice|perfect|awesome|lol|np|got)\b/i.test(message)) return 'ack';
  return 'greeting';
}

export function smallTalkReply(message: string, random: () => number = Math.random): string {
  const kind = smallTalkKind(message);
  const options = SMALL_TALK_REPLIES[kind];
  const choices = options.map((_, i) => i).filter((i) => i !== lastPicked.get(kind));
  const index = choices[Math.floor(random() * choices.length)];
  lastPicked.set(kind, index);
  return options[index];
}

const GENERIC_HINT = new Set([
  'question', 'questions', 'ask', 'asked', 'asking', 'conversation', 'conversations', 'chat', 'chats', 'talk', 'talked',
  'said', 'earlier', 'today', 'yesterday', 'before', 'last', 'thing', 'things', 'stuff', 'anything', 'message', 'messages', 'me', 'you', 'we', 'our', 'my', 's',
]);

const isGenericHint = (hint: string) => (hint.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).every((w) => GENERIC_HINT.has(w));

const CONTINUES = /\b(more|another|again|shorter|longer|simpler|rephrase|rewrite|them|those|these|it|that|else|different|other|\d+)\b/i;
const PRONOUN = /\b(he|she|him|her|his|hers|it|its|they|them|their|that|this|those|these|there)\b/i;
const WRITING_REQUEST = /^\s*(please\s+)?(tell|write|compose|make up|come up with|give|say)\b(\s+me)?(\s+\S+){0,3}\s+(jokes?|poems?|stor(y|ies)|riddles?|pickup lines?|haikus?|limericks?|raps?|roasts?|slogans?)\b/i;
const RANKED = /\b(best|top|famous|most|ranked|list of|rated)\b/i;
const CURRENT_CUE = /\b(latest|last|current(ly)?|now|today|tonight|yesterday|this (week|month|season|year)|recent(ly)?|newest|scores?|results?|standings|news)\b/i;
const REWORD =/\b(shorter|longer|simpler|rephrase|rewrite|reword|summari[sz]e|translate|tl;?dr|bullets?|table|eli5)\b/i;
const MORE = /\b(more|another|again)\b/i;
const wordCount = (message: string) => message.trim().split(/\s+/).length;

const MEMORY_CUE = /\b(did i|did you (tell|say|recommend|suggest|give|answer)|i asked|i told|we (discussed|talked|shortlisted|chose|picked|said|looked)|you (said|told|recommended|gave|suggested|answered)|\b(you|we|i|me|my)\b[^.?!]*\b(earlier|before|previously)|remember|last (time|week|month|night)|yesterday|ago|that (list|shortlist|conversation|answer))\b/i;

export function applyGuards(intent: Intent, message: string, last?: Pick<Turn, 'route' | 'topic'> | null): Intent {
  const out: Intent = { ...intent, queries: intent.queries.slice(0, BUDGET.searches) };
  const lastRoute = last?.route;
  if (out.topicHint && isGenericHint(out.topicHint)) out.topicHint = undefined;

  const memoryCue = MEMORY_CUE.test(message);
  if ((out.timeRefs.length || (out.refersToPast && memoryCue)) && (out.route === 'research' || out.route === 'chat')) out.route = 'recall';

  const continuation = PRONOUN.test(message) || (!out.topicHint && !out.entityRefs.length);
  if (out.route === 'recall' && last && !out.timeRefs.length && !memoryCue && continuation && wordCount(message) <= 6 && !FRESHNESS.test(message)) {
    out.refersToPast = false;
    if (last.route === 'research' && last.topic) {
      out.route = 'research';
      out.queries = [out.standalone ?? `${last.topic} ${message}`];
    } else {
      out.route = 'chat';
      out.queries = [];
    }
  }
  if (out.route === 'research' && last?.route === 'research' && !out.timeRefs.length && !out.entityRefs.length && wordCount(message) <= 6 && FRESHNESS.test(message)) {
    out.route = 'recall';
    out.refersToPast = true;
  }
  if (out.route === 'research' && !out.queries.length && out.standalone) out.queries = [out.standalone];
  if (out.route === 'research' && !out.standalone && last?.route === 'research' && last.topic && wordCount(message) <= 8) {
    out.queries = out.queries.map((q) => (PRONOUN.test(q) && !q.toLowerCase().includes(last.topic!.toLowerCase()) ? `${last.topic} ${q}` : q));
  }
  if (out.route === 'recall' && FRESHNESS.test(message)) out.route = 'recheck';

  if (out.route === 'research' && lastRoute === 'chat' && wordCount(message) <= 5 && CONTINUES.test(message)) {
    out.route = 'chat';
    out.queries = [];
  }

  const writing = WRITING_REQUEST.test(message) && !RANKED.test(message);
  if (out.route === 'research' && !out.timeRefs.length && writing) {
    out.route = 'chat';
    out.queries = [];
    out.aspects = [];
  }

  if (out.route === 'chat' && !out.reply && !out.timeRefs.length && !writing) {
    const factual = out.aspects.some((a) => a !== 'other');
    const afterSearch = (lastRoute === 'research' || lastRoute === 'recheck') && !REWORD.test(message) && !MORE.test(message);
    if (factual || afterSearch) {
      out.route = 'research';
      out.queries = [out.standalone ?? message];
      if (!out.aspects.length) out.aspects = ['fact'];
    }
  }

  if (out.route === 'clarify' && !out.reply) out.reply = "Can you say a bit more about what you're after?";
  if (out.route === 'research' && !out.queries.length) out.queries = [message];
  if (out.route === 'research' && (CURRENT_CUE.test(message) || CURRENT_CUE.test(out.standalone ?? ''))) out.current = true;
  return out;
}

const QUESTION_WORDS = new Set([
  'what', 'did', 'does', 'was', 'were', 'who', 'when', 'where', 'why', 'how', 'have', 'had', 'has', 'tell', 'told', 'said', 'asked',
  'about', 'you', 'your', 'the', 'and', 'for', 'with', 'that', 'this', 'from', 'remember',
]);

function topicWords(message: string): string | undefined {
  const words = (message.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 2 && !QUESTION_WORDS.has(w) && !GENERIC_HINT.has(w));
  return words.length ? words.join(' ') : undefined;
}

function fallbackIntent(message: string, last?: Turn): Intent {
  const base: Intent = { route: 'research', topic: message.slice(0, 60), current: false, refersToPast: false, timeRefs: [], entityRefs: [], aspects: [], queries: [message] };
  if (MEMORY_CUE.test(message)) return { ...base, route: 'recall', refersToPast: true, topicHint: topicWords(message), queries: [] };
  if (WRITING_REQUEST.test(message) && !RANKED.test(message)) return { ...base, route: 'chat', queries: [] };
  if (last?.route === 'chat' && wordCount(message) <= 6) return { ...base, route: 'chat', queries: [] };
  if (last?.route === 'research' && last.topic && wordCount(message) <= 5) return { ...base, queries: [`${last.topic} ${message}`] };
  return base;
}

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
  const last = input.recent.at(-1);
  if (!result.ok) return { intent: applyGuards(fallbackIntent(input.message, last), input.message, last), degraded: true, error: result.error };
  return { intent: applyGuards(result.value, input.message, last), degraded: false };
}
