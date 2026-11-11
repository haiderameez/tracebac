import { CHAINS, ConfigError, SEARCH_ORDER, loadConfig, type Config } from './config.ts';
import { createLLM } from './llm.ts';
import { openMemory } from './memory.ts';
import { createWebSearch } from './search.ts';
import { createApp } from './server.ts';
import { systemClock } from './time.ts';
import { Background } from './turn.ts';

let config: Config;
try {
  config = loadConfig();
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const memory = openMemory();
memory.recoverOrphans();
memory.pruneCache(Date.now() - WEEK_MS);

const llm = createLLM({ keys: config.keys, log: (message) => console.warn(`[llm] ${message}`) });
const web = createWebSearch({
  keys: config.search,
  jinaKey: config.jina,
  cache: { get: (key) => memory.getCache(key), put: (key, kind, body, ttlS, now) => memory.putCache(key, kind, body, ttlS, now) },
  log: (message) => console.warn(`[web] ${message}`),
});
const server = createApp({ clock: systemClock, memory, llm, web, background: new Background(), log: (message) => console.warn(`[ledger] ${message}`), allowClockOverride: config.allowClockOverride });

server.listen(config.port, () => {
  console.log(`tracebac running on http://localhost:${config.port}`);
  for (const [role, slots] of Object.entries(CHAINS)) {
    const active = slots.filter((s) => config.keys[s.provider]).map((s) => `${s.provider}/${s.model}`);
    console.log(`  ${role.padEnd(9)} ${active.join(' -> ')}`);
  }
  console.log(`  search    ${SEARCH_ORDER.filter((id) => config.search[id]).join(' -> ')}`);
  console.log(`  reader    jina${config.jina ? ' (with key)' : ' (no key, 20 requests/min)'}${config.search.tavily ? ' -> tavily extract' : ''}`);
});
