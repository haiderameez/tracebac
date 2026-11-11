import { Exhausted, StreamInterrupted, type LLM } from './llm.ts';
import type { Memory } from './memory.ts';
import { recallMessages } from './prompts.ts';
import { dayLabel, referentLabel, renderAmbiguous, renderNotFound, renderRecall } from './render.ts';
import { localDay, resolveTimeRef, type Clock } from './time.ts';
import type { DateCandidates, Intent, Referent, Route, Turn, TurnEvent } from './types.ts';
import { understand } from './understand.ts';

export interface Deps {
  clock: Clock;
  memory: Memory;
  llm: LLM;
}

export interface TurnRequest {
  sessionId: string;
  userId: string;
  text: string;
  tz: string;
  signal?: AbortSignal;
}

interface Ctx {
  answer: string;
  route: Route | null;
  timings: Record<string, number>;
}

function* say(ctx: Ctx, text: string): Generator<TurnEvent> {
  ctx.answer += text;
  yield { type: 'delta', text };
}

const lap = (ctx: Ctx, name: string, from: number) => {
  ctx.timings[name] = Math.round(performance.now() - from);
};

export async function* runTurn(deps: Deps, req: TurnRequest): AsyncGenerator<TurnEvent> {
  const { memory, llm, clock } = deps;
  const started = performance.now();
  const now = clock.now();
  const turn = memory.beginTurn({ sessionId: req.sessionId, userId: req.userId, text: req.text, askedAt: now, tz: req.tz });
  const ctx: Ctx = { answer: '', route: null, timings: {} };
  let topic = '';
  let status: Turn['status'] = 'done';

  try {
    const today = localDay(now, turn.tz);
    const t0 = performance.now();
    const { intent } = await understand(
      llm,
      {
        message: req.text,
        recent: memory.recentTurns(req.sessionId, 6),
        threadIndex: memory.threadIndex(req.userId, 40),
        today,
        tz: turn.tz,
      },
      req.signal,
    );
    lap(ctx, 'understand', t0);
    topic = intent.topic;
    ctx.route = intent.route;

    if (intent.route === 'chat' || intent.route === 'clarify') {
      yield* say(ctx, intent.reply ?? '');
    } else if (intent.route === 'research') {
      yield* say(ctx, "Web search isn't connected yet, so I can't look that up.");
    } else {
      yield* fromMemory({ deps, req, ctx, intent, now, tz: turn.tz, todayLabel: dayLabel(today.date) });
    }
  } catch (e) {
    if (req.signal?.aborted) {
      status = 'aborted';
    } else {
      status = 'failed';
      yield* say(ctx, `Something broke on my side (${e instanceof Error ? e.message.slice(0, 160) : 'unknown error'}).`);
    }
  }

  lap(ctx, 'total', started);
  memory.finishTurn(turn.id, {
    answerText: ctx.answer,
    route: ctx.route,
    topic: topic || req.text.slice(0, 60),
    answeredAt: clock.now(),
    status,
  });
  yield { type: 'done', turnId: turn.id, route: ctx.route, timings: ctx.timings };
}

async function* fromMemory(a: {
  deps: Deps;
  req: TurnRequest;
  ctx: Ctx;
  intent: Intent;
  now: number;
  tz: string;
  todayLabel: string;
}): AsyncGenerator<TurnEvent> {
  const { deps, req, ctx, intent } = a;

  let dates: DateCandidates | undefined;
  try {
    if (intent.timeRefs[0]) dates = resolveTimeRef(intent.timeRefs[0], a.now, a.tz);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    ctx.route = 'clarify';
    yield* say(ctx, "I couldn't make sense of that date. Which day do you mean?");
    return;
  }

  const ref: Referent = deps.memory.findReferent(req.userId, { dates, topicHint: intent.topicHint, entityRefs: intent.entityRefs });

  if (ref.match === 'none') {
    ctx.route = 'not_found';
    yield* say(ctx, renderNotFound({ range: dates?.primary, topicHint: intent.topicHint, nearest: ref.nearest }));
    return;
  }
  if (ref.match === 'ambiguous') {
    ctx.route = 'clarify';
    yield* say(ctx, renderAmbiguous(ref));
    return;
  }

  yield {
    type: 'recall',
    label: referentLabel(ref),
    quotes: ref.turns.slice(0, 4).map((t) => t.userText),
    entities: ref.entities.map((e) => e.name),
  };

  const t0 = performance.now();
  let wrote = false;
  try {
    for await (const delta of deps.llm.stream('write', recallMessages(req.text, ref, a.todayLabel), { signal: req.signal })) {
      wrote = true;
      yield* say(ctx, delta);
    }
  } catch (e) {
    if (e instanceof StreamInterrupted) yield* say(ctx, '\n\n(the connection to the model dropped, so that answer is cut short)');
    else if (!(e instanceof Exhausted) || req.signal?.aborted) throw e;
  }
  if (!wrote) yield* say(ctx, renderRecall(ref));
  lap(ctx, 'write', t0);
}
