import type { LLM } from './llm.ts';
import type { Memory } from './memory.ts';
import type { WebSearch } from './search.ts';
import type { Clock } from './time.ts';
import type { EvidenceItem, Route, TurnEvent } from './types.ts';

export class Background {
  private tails = new Map<string, Promise<void>>();

  run(key: string, job: () => Promise<void>) {
    const next = (this.tails.get(key) ?? Promise.resolve()).then(job).catch(() => {});
    this.tails.set(key, next);
    next.then(() => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    });
  }

  async settle(key: string, ms: number) {
    const tail = this.tails.get(key);
    if (!tail) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([tail, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
    clearTimeout(timer);
  }
}

export interface Deps {
  clock: Clock;
  memory: Memory;
  llm: LLM;
  web: WebSearch;
  background: Background;
  log?: (message: string) => void;
}

export interface TurnRequest {
  sessionId: string;
  userId: string;
  text: string;
  tz: string;
  signal?: AbortSignal;
}

export interface Ctx {
  turnId: number;
  answer: string;
  route: Route | null;
  timings: Record<string, number>;
  research?: { question: string; evidence: EvidenceItem[] };
}

export function* say(ctx: Ctx, text: string): Generator<TurnEvent> {
  ctx.answer += text;
  yield { type: 'delta', text };
}

export const lap = (ctx: Ctx, name: string, from: number) => {
  ctx.timings[name] = Math.round(performance.now() - from);
};
