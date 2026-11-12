const base = process.env.TRACEBAC_URL ?? 'http://localhost:3000';
const user = process.argv[2] ?? 'demo';
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const health = await fetch(`${base}/api/health`).then((r) => r.json()).catch(() => null);
if (!health) {
  console.error(`can't reach ${base}. start the app first with: npm run dev`);
  process.exit(1);
}
if (!health.clockOverride) {
  console.error('the app is using the real clock only. set ALLOW_CLOCK_OVERRIDE=true in .env, restart it, and run this again');
  process.exit(1);
}

function lastWeekday(isoWeekday) {
  const d = new Date();
  d.setHours(14, 0, 0, 0);
  do d.setDate(d.getDate() - 1);
  while (((d.getDay() + 6) % 7) + 1 !== isoWeekday);
  return d;
}

const tuesday = lastWeekday(2);
const monday = lastWeekday(1);
const history = [
  { when: tuesday, text: 'compare managed postgres hosting for a side project: neon, supabase and render, free tier and paid pricing' },
  { when: monday, text: "i'm choosing a crm for a 20-person sales team. compare hubspot, pipedrive, zoho crm, freshsales and salesforce on pricing" },
].sort((a, b) => a.when - b.when);

async function say({ when, text }, i) {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: `replay-${i}`, userId: user, text, tz, now: when.getTime() }),
  });
  const events = (await res.text()).split('\n\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));
  const answer = events.filter((e) => e.type === 'delta').map((e) => e.text).join('').replace(/\s+/g, ' ').trim();
  console.log(`${when.toDateString()}: ${text.slice(0, 60)}...\n   ${events.at(-1)?.route}: ${answer.slice(0, 110)}...`);
}

for (const [i, turn] of history.entries()) {
  if (i) await wait(20000);
  await say(turn, i);
}

console.log('\nwaiting for the claims from those answers to be saved...');
await wait(25000);

const month = tuesday.toLocaleString('en-GB', { month: 'long' });
console.log(`\ndone. open ${base}/?user=${user} and try:\n`);
console.log('  On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?');
console.log(`  What did I ask you on ${tuesday.getDate()} ${month}? Is your answer still correct today?`);
console.log('  Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?');
