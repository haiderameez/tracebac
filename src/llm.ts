import { CHAINS, PROVIDERS, type ProviderId, type Slot } from './config.ts';
import type { Msg, Result, Role } from './types.ts';

export class Exhausted extends Error {
  retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

export class StreamInterrupted extends Error {}

export interface LLM {
  object<T>(role: Role, messages: Msg[], schema: { parse(data: unknown): T }, opts?: { signal?: AbortSignal; reserve?: number }): Promise<Result<T>>;
  stream(role: Role, messages: Msg[], opts?: { signal?: AbortSignal; maxWaitMs?: number }): AsyncIterable<string>;
  maxInputTokens(role: Role): number;
}

export interface LLMDeps {
  keys: Partial<Record<ProviderId, string>>;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

const FIRST_BYTE_MS: Record<Role, number> = { route: 8000, structure: 40000, write: 10000 };
const IDLE_MS = 15000;
const DAILY_RETRY_MS = 60 * 60 * 1000;
const WINDOW_MS = 60000;

interface ProviderState {
  cooldownUntil: number;
  calls: number[];
  tokens: [number, number][];
}

export function extractJson(text: string): string {
  const unfenced = text.replace(/```(?:json)?/gi, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  return start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced;
}

const estimateTokens = (messages: Msg[]) => Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 3.5) + 400;
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 120);

function timer(parent: AbortSignal | undefined, ms: number) {
  const ctl = new AbortController();
  let id = setTimeout(() => ctl.abort(new Error('timed out')), ms);
  const onParent = () => ctl.abort(parent?.reason);
  if (parent?.aborted) ctl.abort(parent.reason);
  else parent?.addEventListener('abort', onParent, { once: true });
  return {
    signal: ctl.signal,
    touch(next: number) {
      clearTimeout(id);
      id = setTimeout(() => ctl.abort(new Error('timed out')), next);
    },
    stop() {
      clearTimeout(id);
      parent?.removeEventListener('abort', onParent);
      ctl.abort();
    },
  };
}

async function* sseDeltas(res: Response, onChunk: () => void): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    onChunk();
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (json.error) throw new Error(json.error.message ?? 'provider error');
      const delta = json.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) yield delta;
    }
  }
}

export function createLLM(deps: LLMDeps): LLM {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = deps.log ?? (() => {});
  const fail = (errors: string[], message: string) => {
    errors.push(message);
    log(message);
  };
  const keys = deps.keys;
  const states = new Map<string, ProviderState>();
  const providerCooldown = new Map<ProviderId, number>();

  const state = (slot: Slot) => {
    const id = `${slot.provider}/${slot.model}`;
    let s = states.get(id);
    if (!s) {
      s = { cooldownUntil: 0, calls: [], tokens: [] };
      states.set(id, s);
    }
    return s;
  };

  const chain = (role: Role) => CHAINS[role].filter((slot) => keys[slot.provider]);

  function blockedFor(slot: Slot, estimate: number, reserve = 0): { ms: number; reason: string } | null {
    const provider = PROVIDERS[slot.provider];
    const s = state(slot);
    const t = now();
    const daily = providerCooldown.get(slot.provider) ?? 0;
    if (daily > t) return { ms: daily - t, reason: 'daily limit reached' };
    if (s.cooldownUntil > t) return { ms: s.cooldownUntil - t, reason: 'cooling down' };
    s.calls = s.calls.filter((at) => t - at < WINDOW_MS);
    s.tokens = s.tokens.filter(([at]) => t - at < WINDOW_MS);
    const allowed = (provider.rpm ?? Infinity) - reserve;
    if (s.calls.length >= allowed) return { ms: WINDOW_MS - (t - s.calls[s.calls.length - allowed]), reason: 'request limit for this minute reached' };
    const used = s.tokens.reduce((sum, [, n]) => sum + n, 0);
    if (provider.tpm && s.tokens.length && used + estimate > provider.tpm) return { ms: WINDOW_MS - (t - s.tokens[0][0]), reason: 'token limit for this minute reached' };
    return null;
  }

  function spend(slot: Slot, estimate: number) {
    const s = state(slot);
    s.calls.push(now());
    s.tokens.push([now(), estimate]);
  }

  const cool = (slot: Slot, ms: number) => {
    state(slot).cooldownUntil = now() + ms;
  };

  async function failure(slot: Slot, res: Response): Promise<string> {
    const full = await res.text().catch(() => '');
    const body = full.replace(/\s+/g, ' ').slice(0, 160);
    const retryAfter = Number(res.headers.get('retry-after'));
    if (res.status === 429 && /free-models-per-day/.test(full)) {
      const reset = Number(full.match(/"X-RateLimit-Reset"\s*:\s*"?(\d{10,})/i)?.[1]);
      providerCooldown.set(slot.provider, reset > now() ? reset : now() + DAILY_RETRY_MS);
    } else if (res.status === 429) cool(slot, retryAfter > 0 ? retryAfter * 1000 : 30000);
    else if (res.status >= 500) cool(slot, 15000);
    else if ([401, 403, 404].includes(res.status)) cool(slot, 600000);
    return `${slot.provider} ${res.status} ${body}`.trim();
  }

  function post(slot: Slot, messages: Msg[], extra: Record<string, unknown>, signal: AbortSignal) {
    return doFetch(`${PROVIDERS[slot.provider].baseURL}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${keys[slot.provider]}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: slot.model, messages, ...slot.extra, ...extra }),
      signal,
    });
  }

  async function* streamOnce(role: Role, messages: Msg[], opts: { signal?: AbortSignal }): AsyncGenerator<string> {
    const errors: string[] = [];
    const estimate = estimateTokens(messages);
    let soonest = Infinity;

    for (const slot of chain(role)) {
      const blocked = blockedFor(slot, estimate);
      if (blocked) {
        errors.push(`${slot.provider}: ${blocked.reason}`);
        soonest = Math.min(soonest, blocked.ms);
        continue;
      }
      spend(slot, estimate);
      const t = timer(opts.signal, FIRST_BYTE_MS[role]);
      let yielded = false;
      try {
        const res = await post(slot, messages, { stream: true }, t.signal);
        if (!res.ok) {
          fail(errors, await failure(slot, res));
          continue;
        }
        for await (const delta of sseDeltas(res, () => t.touch(IDLE_MS))) {
          yielded = true;
          yield delta;
        }
        if (yielded) return;
        fail(errors, `${slot.provider}: empty reply`);
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        cool(slot, 10000);
        if (yielded) throw new StreamInterrupted(`${slot.provider}: ${describe(e)}`);
        fail(errors, `${slot.provider}: ${describe(e)}`);
      } finally {
        t.stop();
      }
    }

    throw new Exhausted(errors.join('; ') || 'no model provider available', Number.isFinite(soonest) ? soonest : 0);
  }

  return {
    async object<T>(role: Role, messages: Msg[], schema: { parse(data: unknown): T }, opts: { signal?: AbortSignal; reserve?: number } = {}): Promise<Result<T>> {
      const errors: string[] = [];
      const estimate = estimateTokens(messages);

      for (const slot of chain(role)) {
        if (opts.signal?.aborted) return { ok: false, error: 'aborted' };
        const blocked = blockedFor(slot, estimate, opts.reserve);
        if (blocked) {
          errors.push(`${slot.provider}: ${blocked.reason}`);
          continue;
        }
        spend(slot, estimate);
        const started = now();
        let text: string | null = null;

        for (const jsonMode of [true, false]) {
          const t = timer(opts.signal, FIRST_BYTE_MS[role]);
          try {
            const res = await post(slot, messages, jsonMode ? { response_format: { type: 'json_object' } } : {}, t.signal);
            if (res.status === 400 && jsonMode) continue;
            if (!res.ok) {
              fail(errors, await failure(slot, res));
              break;
            }
            const data: any = await res.json();
            text = data.choices?.[0]?.message?.content ?? '';
            break;
          } catch (e) {
            if (opts.signal?.aborted) return { ok: false, error: 'aborted' };
            cool(slot, 10000);
            fail(errors, `${slot.provider}: ${describe(e)}`);
            break;
          } finally {
            t.stop();
          }
        }

        if (text === null) continue;
        try {
          const value = schema.parse(JSON.parse(extractJson(text)));
          return { ok: true, value, provider: slot.provider, model: slot.model, ms: now() - started };
        } catch {
          fail(errors, `${slot.provider}: reply was not valid json for the schema`);
        }
      }

      return { ok: false, error: errors.join('; ') || 'no model provider available' };
    },

    async *stream(role: Role, messages: Msg[], opts: { signal?: AbortSignal; maxWaitMs?: number } = {}): AsyncGenerator<string> {
      const giveUpAt = now() + (opts.maxWaitMs ?? 0);
      while (true) {
        try {
          yield* streamOnce(role, messages, opts);
          return;
        } catch (e) {
          const wait = e instanceof Exhausted ? e.retryAfterMs : 0;
          if (!wait || opts.signal?.aborted || now() + wait > giveUpAt) throw e;
          await sleep(wait + 50);
        }
      }
    },

    maxInputTokens(role: Role): number {
      const slots = chain(role);
      const slot = slots.find((s) => !blockedFor(s, 0)) ?? slots[0];
      return slot ? PROVIDERS[slot.provider].maxInputTokens : 0;
    },
  };
}
