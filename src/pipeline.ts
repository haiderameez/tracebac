import { extract, ledgerEvidence } from './claims.ts';
import { BUDGET } from './config.ts';
import { Exhausted, StreamInterrupted } from './llm.ts';
import { chatMessages, recallMessages } from './prompts.ts';
import { dayLabel, referentLabel, renderAmbiguous, renderNotFound, renderRecall } from './render.ts';
import { recheck } from './recheck.ts';
import { research } from './research.ts';
import { localDay, resolveTimeRef } from './time.ts';
import { lap, say, type Ctx, type Deps, type TurnRequest } from './turn.ts';
import type { DateCandidates, Intent, Referent, Turn, TurnEvent } from './types.ts';
import { understand } from './understand.ts';

export type { Deps, TurnRequest } from './turn.ts';

const EXTRACTION_WAIT_MS = 3000;

export async function* runTurn(deps: Deps, req: TurnRequest): AsyncGenerator<TurnEvent> {
  const { memory, llm, clock } = deps;
  const started = performance.now();
  const now = clock.now();
  const turn = memory.beginTurn({ sessionId: req.sessionId, userId: req.userId, text: req.text, askedAt: now, tz: req.tz });
  const ctx: Ctx = { turnId: turn.id, answer: '', route: null, timings: {} };
  let topic = '';
  let status: Turn['status'] = 'done';

  try {
    const today = localDay(now, turn.tz);
    const recent = memory.recentTurns(req.sessionId, 6);
    const t0 = performance.now();
    const { intent } = await understand(
      llm,
      { message: req.text, recent, threadIndex: memory.threadIndex(req.userId, 40), today, tz: turn.tz },
      req.signal,
    );
    lap(ctx, 'understand', t0);
    topic = intent.topic;
    ctx.route = intent.route;
    const todayLabel = dayLabel(today.date);

    if (intent.reply && (intent.route === 'chat' || intent.route === 'clarify')) {
      yield* say(ctx, intent.reply);
    } else if (intent.route === 'chat') {
      const message = intent.standalone ?? req.text;
      const needsSearch = yield* chat({ deps, req, ctx, recent, todayLabel, message });
      if (needsSearch) {
        ctx.route = 'research';
        const handoff: Intent = { ...intent, route: 'research', aspects: intent.aspects.length ? intent.aspects : ['fact'], queries: [message] };
        yield* research({ deps, req, ctx, intent: handoff, recent, todayLabel, tz: turn.tz });
      }
    } else if (intent.route === 'research') {
      yield* research({ deps, req, ctx, intent, recent, todayLabel, tz: turn.tz });
    } else {
      yield* fromMemory({ deps, req, ctx, intent, recent, now, tz: turn.tz, todayLabel });
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
  const research_ = status === 'done' ? ctx.research : undefined;
  memory.finishTurn(turn.id, {
    answerText: ctx.answer,
    route: ctx.route,
    topic: topic || req.text.slice(0, 60),
    answeredAt: clock.now(),
    status,
    extraction: research_ ? 'pending' : 'none',
  });
  if (research_) scheduleExtraction(deps, turn.id, research_.question, req.userId, ctx.answer, research_.evidence);
  yield { type: 'done', turnId: turn.id, route: ctx.route, timings: ctx.timings };
}

function scheduleExtraction(deps: Deps, turnId: number, question: string, userId: string, answer: string, evidence: NonNullable<Ctx['research']>['evidence']) {
  try {
    deps.memory.saveEvidence(turnId, ledgerEvidence(evidence));
  } catch {
    deps.memory.setExtraction(turnId, 'failed');
    return;
  }

  deps.background.run(userId, async () => {
    const reasons: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, BUDGET.extractRetryMs));
      try {
        deps.memory.commitExtraction(turnId, await extract(deps.llm, { question, answer, evidence }));
        return;
      } catch (e) {
        reasons.push(e instanceof Error ? e.message : String(e));
      }
    }
    deps.log?.(`could not save claims for turn ${turnId}: ${reasons.join(' | ')}`);
    deps.memory.setExtraction(turnId, 'failed');
  });
}

const HANDOFF = 'SEARCH';

async function* chat(a: { deps: Deps; req: TurnRequest; ctx: Ctx; recent: Turn[]; todayLabel: string; message: string }): AsyncGenerator<TurnEvent, boolean> {
  const { deps, req, ctx } = a;
  const t0 = performance.now();
  let wrote = false;
  let held = '';
  let deciding = true;
  try {
    for await (const delta of deps.llm.stream('write', chatMessages(a.message, a.recent, a.todayLabel), { signal: req.signal, maxWaitMs: BUDGET.writeWaitMs })) {
      if (deciding) {
        held += delta;
        const head = held.trimStart();
        if (head.startsWith(HANDOFF)) return true;
        if (head.length < HANDOFF.length && HANDOFF.startsWith(head)) continue;
        deciding = false;
        wrote = true;
        yield* say(ctx, held);
        continue;
      }
      wrote = true;
      yield* say(ctx, delta);
    }
    if (deciding && held) {
      wrote = true;
      yield* say(ctx, held);
    }
  } catch (e) {
    if (e instanceof StreamInterrupted) yield* say(ctx, '\n\n(the connection to the model dropped, so that answer is cut short)');
    else if (!(e instanceof Exhausted) || req.signal?.aborted) throw e;
  }
  if (!wrote) yield* say(ctx, "I can't answer that right now: the free model providers are all over their limits. Try again in a minute.");
  lap(ctx, 'write', t0);
  return false;
}

async function* fromMemory(a: {
  deps: Deps;
  req: TurnRequest;
  ctx: Ctx;
  intent: Intent;
  recent: Turn[];
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

  await deps.background.settle(req.userId, EXTRACTION_WAIT_MS);
  const lastAnswer = !dates && !intent.topicHint && !intent.entityRefs.length ? a.recent.filter((t) => t.route === 'research').at(-1) : undefined;
  const lookup = (): Referent =>
    lastAnswer
      ? deps.memory.referentOfTurn(req.userId, deps.memory.getTurn(lastAnswer.id)!)
      : deps.memory.findReferent(req.userId, { dates, topicHint: intent.topicHint, entityRefs: intent.entityRefs });
  const ref = lookup();

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

  if (intent.route === 'recheck') {
    yield* recheck({ deps, req, ctx, intent, ref, again: lookup, now: a.now, tz: a.tz, todayLabel: a.todayLabel });
    return;
  }

  const t0 = performance.now();
  let wrote = false;
  try {
    for await (const delta of deps.llm.stream('write', recallMessages(req.text, ref, a.todayLabel), { signal: req.signal, maxWaitMs: BUDGET.writeWaitMs })) {
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
