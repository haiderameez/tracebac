export type Route = 'chat' | 'recall' | 'recheck' | 'research' | 'clarify' | 'not_found';
export type Aspect = 'pricing' | 'release' | 'feature' | 'fact' | 'other';
export type Volatility = 'fast' | 'slow' | 'static';
export type Verdict = 'unchanged' | 'changed' | 'unconfirmed' | 'conflict';

export type TimeRef =
  | { kind: 'absolute'; day: number; month: number; year?: number }
  | { kind: 'weekday'; weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7; modifier: 'bare' | 'last' | 'this' }
  | { kind: 'relative'; unit: 'day' | 'week' | 'month'; n: number }
  | { kind: 'vague' };

export interface DateRange { from: string; to: string }
export interface DateCandidates { primary: DateRange; alternates: DateRange[] }

export interface Turn {
  id: number;
  sessionId: string;
  userId: string;
  askedAt: number;
  answeredAt: number | null;
  tz: string;
  localDate: string;
  localDow: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  userText: string;
  answerText: string | null;
  route: Route | null;
  topic: string | null;
  status: 'pending' | 'done' | 'aborted' | 'failed';
  extraction: 'none' | 'pending' | 'done' | 'failed';
}

export interface Entity {
  id: number;
  name: string;
  kind: string;
  aliases: string[];
  officialDomain: string | null;
}

export interface EntitySet {
  id: number;
  label: string;
  createdTurn: number;
  members: Entity[];
  addedAfter: Entity[];
  removedAfter: Entity[];
}

export interface Evidence {
  id: number;
  turnId: number;
  url: string;
  title: string | null;
  chunk: string;
  chunkHash: string;
  fetchedAt: number;
  publishedAt: number | null;
  via: 'page' | 'snippet';
}

export interface HistoryTurn {
  id: number;
  userText: string;
  answerText: string;
  route: Route | null;
  askedAt: number;
  sources: { n: number; url: string; title: string; checkedAt: number; publishedAt?: number }[];
}

export interface Claim {
  id: number;
  turnId: number;
  entityId: number | null;
  aspect: Aspect;
  statement: string;
  value: string | null;
  volatility: Volatility;
  assertedAt: number;
  supersedes: number | null;
  status: 'active' | 'superseded' | 'unverifiable';
  lastCheckedAt: number | null;
  lastVerdict: Verdict | null;
  sources: { evidence: Evidence; quote: string; stance: 'supports' | 'contradicts' }[];
}

export interface Referent {
  match: 'exact' | 'alternate_date' | 'topic_only' | 'ambiguous' | 'none';
  resolvedRange?: DateRange;
  turns: Turn[];
  sets: EntitySet[];
  entities: Entity[];
  claims: Claim[];
  nearest: { localDate: string; topic: string }[];
}

export interface Extraction {
  evidence: { key: string; url: string; title?: string; chunk: string; fetchedAt: number; publishedAt?: number; via: 'page' | 'snippet' }[];
  entities: { name: string; kind?: string; aliases?: string[]; officialDomain?: string }[];
  claims: {
    entity?: string;
    aspect: Aspect;
    statement: string;
    value?: string;
    volatility: Volatility;
    sources: { evidence: string; quote: string; stance?: 'supports' | 'contradicts' }[];
  }[];
  sets: { label: string; add?: string[]; remove?: string[] }[];
}

export interface ExtractionResult {
  claims: number;
  unverifiable: number;
  droppedMembers: string[];
}

export type Role = 'route' | 'structure' | 'write';

export interface Msg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type Result<T> =
  | { ok: true; value: T; provider: string; model: string; ms: number }
  | { ok: false; error: string };

export interface Intent {
  route: 'chat' | 'recall' | 'recheck' | 'research' | 'clarify';
  reply?: string;
  topic: string;
  standalone?: string;
  current: boolean;
  refersToPast: boolean;
  timeRefs: TimeRef[];
  topicHint?: string;
  entityRefs: string[];
  aspects: Aspect[];
  queries: string[];
}

export type TurnEvent =
  | { type: 'status'; text: string }
  | { type: 'recall'; label: string; quotes: string[]; entities: string[] }
  | { type: 'delta'; text: string }
  | { type: 'sources'; items: { n: number; url: string; title: string; checkedAt: number; publishedAt?: number }[] }
  | { type: 'done'; turnId: number; route: Route | null; timings: Record<string, number> };

export interface EvidenceItem {
  n: number;
  url: string;
  title: string;
  text: string;
  via: 'page' | 'snippet';
  fetchedAt: number;
  publishedAt?: number;
}

export interface VerdictRecord {
  claimId: number;
  verdict: Verdict;
  evidence?: Extraction['evidence'][number];
  quote?: string;
  currentValue?: string;
  newStatement?: string;
}
