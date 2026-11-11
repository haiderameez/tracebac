import type { DateCandidates, DateRange, TimeRef } from './types.ts';

export interface Clock { now(): number }
export const systemClock: Clock = { now: () => Date.now() };
export const fixedClock = (instant: number): Clock => ({ now: () => instant });

const DOW: Record<string, 1 | 2 | 3 | 4 | 5 | 6 | 7> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function safeTz(tz: string | undefined): string {
  try {
    if (tz) {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return tz;
    }
  } catch {
  }
  return 'UTC';
}

export function localDay(instant: number, tz: string): { date: string; dow: 1 | 2 | 3 | 4 | 5 | 6 | 7 } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, dow: DOW[get('weekday')] };
}

const toMs = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => fromMs(toMs(d) + n * 86_400_000);
export const dowOf = (d: string) => ((new Date(toMs(d)).getUTCDay() + 6) % 7) + 1;

function ymd(y: number, m: number, d: number): string | null {
  const ms = Date.UTC(y, m - 1, d);
  const s = fromMs(ms);
  return s === `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` ? s : null;
}

const day = (d: string): DateRange => ({ from: d, to: d });
const clamp = (r: DateRange, today: string): DateRange => ({ from: r.from, to: r.to > today ? today : r.to });

export function resolveTimeRef(ref: TimeRef, now: number, tz: string): DateCandidates {
  const { date: today, dow: todayDow } = localDay(now, tz);

  switch (ref.kind) {
    case 'absolute': {
      const ty = +today.slice(0, 4);
      if (ref.year !== undefined) {
        const d = ymd(ref.year, ref.month, ref.day);
        if (!d) throw new RangeError(`no such date: ${ref.day}/${ref.month}/${ref.year}`);
        return { primary: day(d), alternates: [] };
      }
      for (let y = ty; y >= ty - 8; y--) {
        const d = ymd(y, ref.month, ref.day);
        if (d && d <= today) return { primary: day(d), alternates: [] };
      }
      throw new RangeError(`no such date: ${ref.day}/${ref.month}`);
    }

    case 'weekday': {
      if (ref.modifier === 'this') {
        return { primary: day(addDays(today, ref.weekday - todayDow)), alternates: [] };
      }
      const back = ((todayDow - ref.weekday + 7) % 7) || 7;
      const recent = addDays(today, -back);
      if (ref.modifier === 'bare') {
        return { primary: day(recent), alternates: back === 7 ? [day(today)] : [] };
      }
      return { primary: day(recent), alternates: back === 7 ? [] : [day(addDays(recent, -7))] };
    }

    case 'relative': {
      if (!Number.isInteger(ref.n) || ref.n < 0) throw new RangeError(`bad offset: ${ref.n}`);
      if (ref.unit === 'day') {
        const d = addDays(today, -ref.n);
        return { primary: day(d), alternates: ref.n >= 7 ? [day(addDays(d, -1)), day(addDays(d, 1))] : [] };
      }
      if (ref.unit === 'week') {
        const monday = addDays(today, -(todayDow - 1) - 7 * ref.n);
        return { primary: clamp({ from: monday, to: addDays(monday, 6) }, today), alternates: [] };
      }
      const idx = +today.slice(0, 4) * 12 + (+today.slice(5, 7) - 1) - ref.n;
      const y = Math.floor(idx / 12);
      const m = (idx % 12) + 1;
      const first = ymd(y, m, 1)!;
      const last = addDays(ymd(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1)!, -1);
      return { primary: clamp({ from: first, to: last }, today), alternates: [] };
    }

    case 'vague':
      return { primary: { from: '1970-01-01', to: today }, alternates: [] };
  }
}
