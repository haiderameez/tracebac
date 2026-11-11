import type { Role } from './types.ts';

export type ProviderId = 'groq' | 'cerebras' | 'gemini' | 'openrouter';

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

const OPENROUTER_MODEL = 'baidu/ernie-5.5-flash-preview:free';
const groqOss = { temperature: 0.2, reasoning_effort: 'low', include_reasoning: false };
const cerebrasOss = { temperature: 0.2, reasoning_effort: 'low' };
const gemini = { reasoning_effort: 'low' };

export const CHAINS: Record<Role, Slot[]> = {
  route: [
    { provider: 'groq', model: 'openai/gpt-oss-20b', extra: groqOss },
    { provider: 'gemini', model: 'gemini-3.5-flash-lite', extra: gemini },
    { provider: 'cerebras', model: 'qwen-3.8-27b', extra: { temperature: 0.2 } },
    { provider: 'openrouter', model: OPENROUTER_MODEL, extra: { temperature: 0.2 } },
  ],
  structure: [
    { provider: 'cerebras', model: 'gpt-oss-120b', extra: cerebrasOss },
    { provider: 'gemini', model: 'gemini-3.8-flash', extra: gemini },
    { provider: 'groq', model: 'openai/gpt-oss-120b', extra: groqOss },
    { provider: 'groq', model: 'openai/gpt-oss-20b', extra: groqOss },
    { provider: 'openrouter', model: OPENROUTER_MODEL, extra: { temperature: 0.2 } },
  ],
  write: [
    { provider: 'gemini', model: 'gemini-3.8-flash', extra: gemini },
    { provider: 'cerebras', model: 'gpt-oss-120b', extra: cerebrasOss },
    { provider: 'groq', model: 'openai/gpt-oss-120b', extra: groqOss },
    { provider: 'groq', model: 'openai/gpt-oss-20b', extra: groqOss },
    { provider: 'openrouter', model: OPENROUTER_MODEL, extra: { temperature: 0.2 } },
  ],
};

const KEY_PRIORITY: ProviderId[] = ['groq', 'cerebras', 'gemini', 'openrouter'];

export interface Config {
  keys: Partial<Record<ProviderId, string>>;
  port: number;
  allowClockOverride: boolean;
}

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const keys: Partial<Record<ProviderId, string>> = {};
  for (const id of Object.keys(PROVIDERS) as ProviderId[]) {
    const value = env[PROVIDERS[id].keyEnv]?.trim();
    if (value) keys[id] = value;
  }

  if (!KEY_PRIORITY.some((id) => keys[id])) {
    const lines = KEY_PRIORITY.map((id) => `  ${PROVIDERS[id].keyEnv.padEnd(18)} ${PROVIDERS[id].signup}`);
    throw new ConfigError(
      ['no model api key found. put at least one of these in .env (all free, no card):', ...lines, '', 'see .env.example'].join('\n'),
    );
  }

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`PORT must be a number between 1 and 65535, got "${env.PORT}"`);

  return { keys, port, allowClockOverride: env.ALLOW_CLOCK_OVERRIDE === 'true' };
}
