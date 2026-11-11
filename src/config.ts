import type { Role, Volatility } from './types.ts';

export type ProviderId = 'groq' | 'cerebras' | 'gemini' | 'openrouter';
export type SearchId = 'tavily' | 'exa' | 'serper';

export interface Provider {
  baseURL: string;
  keyEnv: string;
  signup: string;
  rpm?: number;
  tpm?: number;
  maxInputTokens: number;
}

export interface Slot {
  provider: ProviderId;
  model: string;
  extra?: Record<string, unknown>;
}

export const PROVIDERS: Record<ProviderId, Provider> = {
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    signup: 'https://console.groq.com/keys',
    rpm: 30,
    tpm: 8000,
    maxInputTokens: 6000,
  },
  cerebras: {
    baseURL: 'https://api.cerebras.ai/v1',
    keyEnv: 'CEREBRAS_API_KEY',
    signup: 'https://cloud.cerebras.ai',
    rpm: 5,
    tpm: 30000,
    maxInputTokens: 24000,
  },
  gemini: {
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY',
    signup: 'https://aistudio.google.com/apikey',
    maxInputTokens: 32000,
  },
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    signup: 'https://openrouter.ai/keys',
    rpm: 20,
    maxInputTokens: 16000,
  },
};

const OPENROUTER_SLOTS: Slot[] = [
  'baidu/ernie-5.5-flash-preview:free',
  'nvidia/nemotron-3.5-lightning:free',
  'cohere/north-mini-code:free',
].map((model) => ({ provider: 'openrouter', model, extra: { temperature: 0.2 } }));
const OUTPUT_CAP: Record<Role, number> = { route: 1000, structure: 4000, write: 2000 };

const groq = (model: string, role: Role): Slot => ({
  provider: 'groq',
  model,
  extra: { temperature: 0.2, reasoning_effort: 'low', include_reasoning: false, max_completion_tokens: OUTPUT_CAP[role] },
});
const cerebras = (model: string, role: Role): Slot => {
  const oss = model === 'gpt-oss-120b';
  return {
    provider: 'cerebras',
    model,
    extra: { temperature: 0.2, max_completion_tokens: OUTPUT_CAP[role] * (oss ? 1 : 2), ...(oss ? { reasoning_effort: 'low' } : {}) },
  };
};
const gemini = (model: string): Slot => ({ provider: 'gemini', model, extra: { reasoning_effort: 'low' } });

export const CHAINS: Record<Role, Slot[]> = {
  route: [
    groq('openai/gpt-oss-20b', 'route'),
    cerebras('gpt-oss-120b', 'route'),
    gemini('gemini-3.5-flash-lite'),
    ...OPENROUTER_SLOTS,
  ],
  structure: [
    cerebras('gpt-oss-120b', 'structure'),
    cerebras('qwen-3.8-27b', 'structure'),
    gemini('gemini-3.8-flash'),
    groq('openai/gpt-oss-120b', 'structure'),
    groq('openai/gpt-oss-20b', 'structure'),
    ...OPENROUTER_SLOTS,
  ],
  write: [
    gemini('gemini-3.8-flash'),
    cerebras('gpt-oss-120b', 'write'),
    cerebras('qwen-3.8-27b', 'write'),
    groq('openai/gpt-oss-120b', 'write'),
    groq('openai/gpt-oss-20b', 'write'),
    ...OPENROUTER_SLOTS,
  ],
};

export const SEARCH_PROVIDERS: Record<SearchId, { keyEnv: string; signup: string }> = {
  tavily: { keyEnv: 'TAVILY_API_KEY', signup: 'https://app.tavily.com' },
  exa: { keyEnv: 'EXA_API_KEY', signup: 'https://dashboard.exa.ai' },
  serper: { keyEnv: 'SERPER_API_KEY', signup: 'https://serper.dev' },
};

export const SEARCH_ORDER: SearchId[] = ['tavily', 'exa', 'serper'];
const MODEL_ORDER: ProviderId[] = ['groq', 'cerebras', 'gemini', 'openrouter'];

export const BUDGET = {
  searches: 6,
  reads: 6,
  concurrency: 5,
  perSearchMs: 6000,
  perReadMs: 8000,
  softDeadlineMs: 12000,
  evidenceTokens: 4000,
  maxChunks: 10,
  chunkChars: 1200,
  readWant: 3,
  readGraceMs: 2500,
  extractRetryMs: 15000,
  writeWaitMs: 25000,
};

export const FRESH_MS: Record<Volatility, number> = {
  fast: 30 * 60 * 1000,
  slow: 24 * 60 * 60 * 1000,
  static: 7 * 24 * 60 * 60 * 1000,
};

export interface Config {
  keys: Partial<Record<ProviderId, string>>;
  search: Partial<Record<SearchId, string>>;
  jina?: string;
  port: number;
  allowClockOverride: boolean;
}

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const read = (name: string) => env[name]?.trim() || undefined;

  const keys: Partial<Record<ProviderId, string>> = {};
  for (const id of MODEL_ORDER) {
    const value = read(PROVIDERS[id].keyEnv);
    if (value) keys[id] = value;
  }
  const search: Partial<Record<SearchId, string>> = {};
  for (const id of SEARCH_ORDER) {
    const value = read(SEARCH_PROVIDERS[id].keyEnv);
    if (value) search[id] = value;
  }

  const lines = (items: { keyEnv: string; signup: string }[]) => items.map((p) => `  ${p.keyEnv.padEnd(18)} ${p.signup}`);
  const missing: string[] = [];
  if (!Object.keys(keys).length) missing.push('a model key, at least one of:', ...lines(MODEL_ORDER.map((id) => PROVIDERS[id])), '');
  if (!Object.keys(search).length) missing.push('a search key, at least one of:', ...lines(SEARCH_ORDER.map((id) => SEARCH_PROVIDERS[id])), '');
  if (missing.length) {
    throw new ConfigError(['missing api keys. put these in .env (all free, no card), see .env.example', '', ...missing].join('\n').trimEnd());
  }

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`PORT must be a number between 1 and 65535, got "${env.PORT}"`);

  return { keys, search, jina: read('JINA_API_KEY'), port, allowClockOverride: env.ALLOW_CLOCK_OVERRIDE === 'true' };
}
