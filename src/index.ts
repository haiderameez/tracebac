import { CHAINS, ConfigError, loadConfig, type Config } from './config.ts';
import { createLLM } from './llm.ts';
import { openMemory } from './memory.ts';
import { createApp } from './server.ts';
import { systemClock } from './time.ts';

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

const memory = openMemory();
memory.recoverOrphans();
const llm = createLLM({ keys: config.keys, log: (message) => console.warn(`[llm] ${message}`) });
const server = createApp({ clock: systemClock, memory, llm, allowClockOverride: config.allowClockOverride });

server.listen(config.port, () => {
  console.log(`tracebac running on http://localhost:${config.port}`);
  for (const [role, slots] of Object.entries(CHAINS)) {
    const active = slots.filter((s) => config.keys[s.provider]).map((s) => `${s.provider}/${s.model}`);
    console.log(`  ${role.padEnd(9)} ${active.join(' -> ') || 'no provider'}`);
  }
});
