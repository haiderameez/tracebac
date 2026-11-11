import { domainOf } from './search.ts';
import { dowOf } from './time.ts';
import type { DateRange, EvidenceItem, Referent } from './types.ts';

const DAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

export function dayLabel(date: string): string {
  return `${DAYS[dowOf(date)]} ${+date.slice(8, 10)} ${MONTHS[+date.slice(5, 7) - 1]}`;
}

function rangeLabel(range: DateRange): string {
  return range.from === range.to ? dayLabel(range.from) : `${dayLabel(range.from)} to ${dayLabel(range.to)}`;
}

export function referentLabel(ref: Referent): string {
  return [...new Set(ref.turns.map((t) => dayLabel(t.localDate)))].join(', ');
}

export function renderNotFound(q: { range?: DateRange; topicHint?: string; nearest: Referent['nearest'] }): string {
  const what = q.range ? `a conversation from ${rangeLabel(q.range)}` : q.topicHint ? `an earlier conversation about ${q.topicHint}` : 'an earlier conversation like that';
  if (!q.nearest.length) {
    return `I don't have ${what}. We haven't talked before today. If you tell me what the question was, I'll answer it now and keep it so I can re-check it later.`;
  }
  const closest = q.nearest.map((n) => `${dayLabel(n.localDate)} (${n.topic})`).join(', ');
  return `I don't have ${what}. The closest I have: ${closest}. Tell me which one you mean, or ask it again and I'll answer it fresh.`;
}

export function renderAmbiguous(ref: Referent): string {
  const seen = new Set<string>();
  const options: string[] = [];
  for (const t of ref.turns) {
    const option = `${dayLabel(t.localDate)} (${t.topic || clip(t.userText, 50)})`;
    if (!seen.has(option)) {
      seen.add(option);
      options.push(option);
    }
  }
  return `Which one do you mean: ${options.join(' or ')}?`;
}

export function renderRecall(ref: Referent): string {
  const parts = ref.turns.slice(0, 3).map((t) => {
    const asked = `On ${dayLabel(t.localDate)} you asked:\n> ${t.userText}`;
    return t.answerText ? `${asked}\n\nI answered: ${clip(t.answerText, 700)}` : asked;
  });
  return `${parts.join('\n\n')}\n\nThe free model providers are all over their limits right now, so this is the stored record, not a summary.`;
}

export function memoryRows(ref: Referent): string {
  const lines: string[] = [];
  const turnDate = (turnId: number) => {
    const turn = ref.turns.find((t) => t.id === turnId);
    return turn ? dayLabel(turn.localDate) : 'earlier';
  };

  for (const t of ref.turns.slice(0, 4)) {
    lines.push(`[${dayLabel(t.localDate)}] the user asked: "${t.userText}"`);
    if (t.answerText) lines.push(`[${dayLabel(t.localDate)}] you answered: "${clip(t.answerText, 1200)}"`);
  }
  if (ref.turns.length > 4) lines.push(`(${ref.turns.length - 4} more turns not shown)`);

  for (const c of ref.claims.slice(0, 30)) {
    const entity = ref.entities.find((e) => e.id === c.entityId)?.name ?? 'general';
    const value = c.value ? ` [value: ${c.value}]` : '';
    const source = c.sources[0] ? ` source: ${c.sources[0].evidence.url}` : ' (no source recorded)';
    lines.push(`- ${entity} (${c.aspect}, recorded ${turnDate(c.turnId)}): ${c.statement}${value}${source}`);
  }

  for (const s of ref.sets) {
    const names = (xs: { name: string }[]) => xs.map((x) => x.name).join(', ');
    lines.push(`list "${s.label}" at the time: ${names(s.members)}`);
    if (s.addedAfter.length) lines.push(`added to that list since: ${names(s.addedAfter)}`);
    if (s.removedAfter.length) lines.push(`removed from that list since: ${names(s.removedAfter)}`);
  }

  return lines.join('\n');
}

export function renderSources(evidence: EvidenceItem[]): string {
  const lines = evidence.slice(0, 5).map((e) => `- ${clip(e.title, 70)} (${domainOf(e.url)}): ${clip(e.text.replace(/\s+/g, ' '), 160)} [${e.n}]`);
  return `The free model providers are all over their limits right now, so I couldn't write this up. Here is what I found:\n${lines.join('\n')}`;
}
