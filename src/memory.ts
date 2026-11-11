import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { localDay, safeTz } from './time.ts';
import type {
  Claim, DateCandidates, DateRange, Entity, EntitySet, Evidence, Extraction, ExtractionResult, Referent, Route, Turn,
} from './types.ts';

type Row = Record<string, any>;
type P = string | number | null;

export const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const DOW_NAME = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const STOP = new Set(['the', 'a', 'an', 'of', 'about', 'for', 'and', 'to', 'in', 'on', 'my', 'our', 'your', 'that', 'this', 'with', 'is', 'are']);
const inList = (ids: unknown[]) => `(${ids.map(() => '?').join(',')})`;
const REFERENCEABLE = `status != 'pending'`;

export function openMemory(path = './data/tracebac.db'): Memory {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  return new Memory(db);
}

export class Memory {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  private run(sql: string, ...p: P[]) { return this.db.prepare(sql).run(...p); }
  private all(sql: string, ...p: P[]): Row[] { return this.db.prepare(sql).all(...p) as Row[]; }
  private one(sql: string, ...p: P[]): Row | undefined { return this.db.prepare(sql).get(...p) as Row | undefined; }
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const v = fn();
      this.db.exec('COMMIT');
      return v;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  beginTurn(t: { sessionId: string; userId: string; text: string; askedAt: number; tz: string }): Turn {
    const tz = safeTz(t.tz);
    const { date, dow } = localDay(t.askedAt, tz);
    return this.tx(() => {
      this.run('INSERT OR IGNORE INTO sessions(id, user_id, started_at) VALUES (?,?,?)', t.sessionId, t.userId, t.askedAt);
      const r = this.run(
        'INSERT INTO turns(session_id, user_id, asked_at, tz, local_date, local_dow, user_text) VALUES (?,?,?,?,?,?,?)',
        t.sessionId, t.userId, t.askedAt, tz, date, dow, t.text,
      );
      const id = Number(r.lastInsertRowid);
      this.run('INSERT INTO turns_fts(rowid, topic, user_text, answer_text) VALUES (?,?,?,?)', id, '', t.text, '');
      return this.getTurn(id)!;
    });
  }

  finishTurn(id: number, r: {
    answerText: string; route: Route | null; topic: string; answeredAt: number; status: Turn['status']; extraction?: Turn['extraction'];
  }) {
    this.tx(() => {
      this.run(
        'UPDATE turns SET answer_text=?, route=?, topic=?, answered_at=?, status=?, extraction=? WHERE id=?',
        r.answerText, r.route, r.topic, r.answeredAt, r.status, r.extraction ?? 'none', id,
      );
      const t = this.getTurn(id)!;
      this.run('DELETE FROM turns_fts WHERE rowid = ?', id);
      this.run('INSERT INTO turns_fts(rowid, topic, user_text, answer_text) VALUES (?,?,?,?)', id, r.topic, t.userText, r.answerText);
    });
  }

  setExtraction(id: number, state: Turn['extraction']) {
    this.run('UPDATE turns SET extraction=? WHERE id=?', state, id);
  }

  recoverOrphans(): number {
    this.run(`UPDATE turns SET extraction='failed' WHERE extraction='pending'`);
    return Number(this.run(`UPDATE turns SET status='failed' WHERE status='pending'`).changes);
  }

  getTurn(id: number): Turn | undefined {
    const r = this.one('SELECT * FROM turns WHERE id=?', id);
    return r && mapTurn(r);
  }

  recentTurns(sessionId: string, n: number): Turn[] {
    return this.all(
      `SELECT * FROM (SELECT * FROM turns WHERE session_id=? AND ${REFERENCEABLE} ORDER BY asked_at DESC, id DESC LIMIT ?)
       ORDER BY asked_at, id`, sessionId, n,
    ).map(mapTurn);
  }

  threadIndex(userId: string, limit: number): string[] {
    const turns = this.all(
      `SELECT * FROM (SELECT * FROM turns WHERE user_id=? AND status IN ('done','aborted') ORDER BY asked_at DESC, id DESC LIMIT ?)
       ORDER BY asked_at, id`, userId, limit,
    ).map(mapTurn);
    return turns.map((t) => {
      const ents = this.all(
        `SELECT e.name FROM turn_entities te JOIN entities e ON e.id=te.entity_id WHERE te.turn_id=? ORDER BY e.id LIMIT 5`, t.id,
      ).map((r) => r.name);
      const label = t.topic || t.userText.slice(0, 60);
      return [`${t.localDate} ${DOW_NAME[t.localDow]}`, label, ...(ents.length ? [ents.join(', ')] : [])].join(' · ');
    });
  }

  private findEntity(userId: string, names: string[]): Row | undefined {
    const keys = names.map(norm);
    return this.all('SELECT * FROM entities WHERE user_id=?', userId).find((r) =>
      [r.name, ...JSON.parse(r.aliases)].some((a: string) => keys.includes(norm(a))));
  }

  private upsertEntity(userId: string, e: { name: string; kind?: string; aliases?: string[]; officialDomain?: string }): number {
    const hit = this.findEntity(userId, [e.name, ...(e.aliases ?? [])]);
    if (!hit) {
      return Number(this.run(
        'INSERT INTO entities(user_id, name, kind, aliases, official_domain) VALUES (?,?,?,?,?)',
        userId, e.name, e.kind ?? 'other', JSON.stringify(e.aliases ?? []), e.officialDomain ?? null,
      ).lastInsertRowid);
    }
    const aliases: string[] = JSON.parse(hit.aliases);
    for (const a of [e.name, ...(e.aliases ?? [])]) {
      if (norm(a) !== norm(hit.name) && !aliases.some((x) => norm(x) === norm(a))) aliases.push(a);
    }
    this.run('UPDATE entities SET aliases=?, official_domain=COALESCE(official_domain, ?) WHERE id=?',
      JSON.stringify(aliases), e.officialDomain ?? null, hit.id);
    return hit.id;
  }

  commitExtraction(turnId: number, x: Extraction): ExtractionResult {
    const turn = this.getTurn(turnId);
    if (!turn) throw new Error(`no such turn: ${turnId}`);
    const answer = norm(turn.answerText ?? '');
    const result: ExtractionResult = { claims: 0, unverifiable: 0, droppedMembers: [] };

    return this.tx(() => {
      const link = (entityId: number) =>
        this.run('INSERT OR IGNORE INTO turn_entities(turn_id, entity_id) VALUES (?,?)', turnId, entityId);

      const ev = new Map<string, { id: number; chunk: string }>();
      for (const e of x.evidence) {
        const id = Number(this.run(
          'INSERT INTO evidence(turn_id, url, title, chunk, chunk_hash, fetched_at, published_at, via) VALUES (?,?,?,?,?,?,?,?)',
          turnId, e.url, e.title ?? null, e.chunk, sha(norm(e.chunk)), e.fetchedAt, e.publishedAt ?? null, e.via,
        ).lastInsertRowid);
        ev.set(e.key, { id, chunk: norm(e.chunk) });
      }

      for (const e of x.entities) link(this.upsertEntity(turn.userId, e));

      for (const c of x.claims) {
        const entityId = c.entity ? this.upsertEntity(turn.userId, { name: c.entity }) : null;
        if (entityId) link(entityId);
        const sources = c.sources.filter((s) => {
          const q = norm(s.quote);
          return q.length > 0 && !!ev.get(s.evidence)?.chunk.includes(q);
        });
        const status = sources.length ? 'active' : 'unverifiable';
        const volatility = c.aspect === 'pricing' || c.aspect === 'release' ? 'fast' : c.volatility;
        const claimId = Number(this.run(
          `INSERT INTO claims(turn_id, user_id, entity_id, aspect, statement, value, volatility, asserted_at, status)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          turnId, turn.userId, entityId, c.aspect, c.statement, c.value ?? null, volatility, turn.askedAt, status,
        ).lastInsertRowid);
        for (const s of sources) {
          this.run('INSERT OR IGNORE INTO claim_evidence(claim_id, evidence_id, quote, stance) VALUES (?,?,?,?)',
            claimId, ev.get(s.evidence)!.id, s.quote, s.stance ?? 'supports');
        }
        result.claims++;
        if (status === 'unverifiable') result.unverifiable++;
      }

      for (const s of x.sets) {
        let set = this.one('SELECT id FROM sets WHERE user_id=? AND lower(label)=lower(?)', turn.userId, s.label);
        if (!set) {
          set = { id: Number(this.run('INSERT INTO sets(user_id, label, created_turn) VALUES (?,?,?)', turn.userId, s.label, turnId).lastInsertRowid) };
        }
        for (const name of s.add ?? []) {
          if (!answer.includes(norm(name))) {
            result.droppedMembers.push(name);
            continue;
          }
          const entityId = this.upsertEntity(turn.userId, { name });
          link(entityId);
          const open = this.one('SELECT 1 FROM set_members WHERE set_id=? AND entity_id=? AND removed_turn IS NULL', set.id, entityId);
          if (!open) this.run('INSERT INTO set_members(set_id, entity_id, added_turn) VALUES (?,?,?)', set.id, entityId, turnId);
        }
        for (const name of s.remove ?? []) {
          const hit = this.findEntity(turn.userId, [name]);
          if (hit) this.run('UPDATE set_members SET removed_turn=? WHERE set_id=? AND entity_id=? AND removed_turn IS NULL', turnId, set.id, hit.id);
        }
      }

      this.run(`UPDATE turns SET extraction='done' WHERE id=?`, turnId);
      return result;
    });
  }

  findReferent(userId: string, q: { dates?: DateCandidates; topicHint?: string; entityRefs?: string[] }): Referent {
    const hint = q.topicHint?.trim() ?? '';
    const hintTurns = hint ? this.ftsSearch(userId, hint, 50) : [];
    const hintIds = new Set(hintTurns.map((t) => t.id));
    const entIds = this.resolveEntityIds(userId, q.entityRefs ?? []);
    const entTurns = this.turnsMentioning(userId, entIds, 50);
    const entTurnIds = new Set(entTurns.map((t) => t.id));
    const narrowing = !!hint || entIds.length > 0;
    const matches = (t: Turn) => !narrowing || hintIds.has(t.id) || entTurnIds.has(t.id);

    let match: Referent['match'] = 'none';
    let turns: Turn[] = [];
    let resolvedRange: DateRange | undefined;

    if (q.dates) {
      const cands = [q.dates.primary, ...q.dates.alternates];
      const found = cands.map((range) => ({ range, turns: this.turnsInRange(userId, range).filter(matches) }));
      const hits = found.filter((f) => f.turns.length > 0);
      if (hits.length === 1) {
        match = hits[0] === found[0] ? 'exact' : 'alternate_date';
        resolvedRange = hits[0].range;
        turns = hits[0].turns;
      } else if (hits.length > 1) {
        match = 'ambiguous';
        turns = hits.flatMap((h) => h.turns);
      }
    } else if (narrowing) {
      const ranked = new Map<number, Turn>();
      for (const t of [...hintTurns, ...entTurns]) if (!ranked.has(t.id)) ranked.set(t.id, t);
      turns = [...ranked.values()].slice(0, 5).sort((a, b) => a.askedAt - b.askedAt || a.id - b.id);
      if (turns.length) match = 'topic_only';
    }

    const nearest = this.nearest(userId, q.dates?.primary.from ?? null);
    if (!turns.length) return { match: 'none', turns: [], sets: [], entities: [], claims: [], nearest };

    return {
      match, resolvedRange, turns, nearest,
      entities: this.entitiesFor(turns.map((t) => t.id)),
      claims: this.claimsFor(turns.map((t) => t.id)),
      sets: this.setsFor(userId, turns),
    };
  }

  private turnsInRange(userId: string, r: DateRange): Turn[] {
    return this.all(
      `SELECT * FROM turns WHERE user_id=? AND ${REFERENCEABLE} AND local_date BETWEEN ? AND ? ORDER BY asked_at, id`,
      userId, r.from, r.to,
    ).map(mapTurn);
  }

  private ftsSearch(userId: string, text: string, limit: number): Turn[] {
    const tokens = (norm(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 2 && !STOP.has(t));
    if (!tokens.length) return [];
    return this.all(
      `SELECT t.* FROM turns_fts f JOIN turns t ON t.id = f.rowid
       WHERE turns_fts MATCH ? AND t.user_id=? AND t.${REFERENCEABLE}
       ORDER BY bm25(turns_fts) LIMIT ?`,
      tokens.map((t) => `"${t}"`).join(' OR '), userId, limit,
    ).map(mapTurn);
  }

  private resolveEntityIds(userId: string, refs: string[]): number[] {
    const ids = new Set<number>();
    for (const r of refs) {
      const hit = this.findEntity(userId, [r]);
      if (hit) ids.add(hit.id);
    }
    return [...ids];
  }

  private turnsMentioning(userId: string, entityIds: number[], limit: number): Turn[] {
    if (!entityIds.length) return [];
    return this.all(
      `SELECT DISTINCT t.* FROM turn_entities te JOIN turns t ON t.id = te.turn_id
       WHERE te.entity_id IN ${inList(entityIds)} AND t.user_id=? AND t.${REFERENCEABLE}
       ORDER BY t.asked_at DESC, t.id DESC LIMIT ?`,
      ...entityIds, userId, limit,
    ).map(mapTurn);
  }

  private nearest(userId: string, target: string | null): { localDate: string; topic: string }[] {
    const label = `COALESCE(NULLIF(topic,''), substr(user_text,1,60))`;
    const rows = target
      ? this.all(`SELECT local_date, ${label} AS topic FROM turns WHERE user_id=? AND ${REFERENCEABLE}
                  ORDER BY abs(julianday(local_date) - julianday(?)), asked_at DESC LIMIT 20`, userId, target)
      : this.all(`SELECT local_date, ${label} AS topic FROM turns WHERE user_id=? AND ${REFERENCEABLE}
                  ORDER BY asked_at DESC LIMIT 20`, userId);
    const seen = new Set<string>();
    const out: { localDate: string; topic: string }[] = [];
    for (const r of rows) {
      const k = `${r.local_date}|${r.topic}`;
      if (!seen.has(k) && out.length < 5) {
        seen.add(k);
        out.push({ localDate: r.local_date, topic: r.topic });
      }
    }
    return out;
  }

  private entitiesFor(turnIds: number[]): Entity[] {
    return this.all(
      `SELECT DISTINCT e.* FROM turn_entities te JOIN entities e ON e.id = te.entity_id
       WHERE te.turn_id IN ${inList(turnIds)} ORDER BY e.id`, ...turnIds,
    ).map(mapEntity);
  }

  private claimsFor(turnIds: number[]): Claim[] {
    return this.all(`SELECT * FROM claims WHERE turn_id IN ${inList(turnIds)} ORDER BY id`, ...turnIds).map((r) => ({
      id: r.id, turnId: r.turn_id, entityId: r.entity_id, aspect: r.aspect, statement: r.statement, value: r.value,
      volatility: r.volatility, assertedAt: r.asserted_at, supersedes: r.supersedes, status: r.status,
      lastCheckedAt: r.last_checked_at, lastVerdict: r.last_verdict,
      sources: this.all(
        `SELECT e.*, ce.quote, ce.stance FROM claim_evidence ce JOIN evidence e ON e.id = ce.evidence_id WHERE ce.claim_id=?`, r.id,
      ).map((s) => ({ evidence: mapEvidence(s), quote: s.quote, stance: s.stance })),
    }));
  }

  private setsFor(userId: string, turns: Turn[]): EntitySet[] {
    const ids = turns.map((t) => t.id);
    const byId = new Map(turns.map((t) => [t.id, t]));
    const sets = this.all(
      `SELECT DISTINCT s.* FROM sets s LEFT JOIN set_members m ON m.set_id = s.id
       WHERE s.user_id=? AND (s.created_turn IN ${inList(ids)} OR m.added_turn IN ${inList(ids)})`,
      userId, ...ids, ...ids,
    );
    return sets.map((s) => {
      const rows = this.all(
        `SELECT e.*, m.added_turn, a.asked_at AS added_at, r.asked_at AS removed_at
         FROM set_members m JOIN entities e ON e.id = m.entity_id JOIN turns a ON a.id = m.added_turn
         LEFT JOIN turns r ON r.id = m.removed_turn WHERE m.set_id=? ORDER BY e.id`, s.id,
      );
      const touching = turns.filter((t) => t.id === s.created_turn || rows.some((r) => r.added_turn === t.id));
      const T = Math.max(...(touching.length ? touching : turns).map((t) => t.askedAt));
      const baseline = rows.filter((r) => r.added_at <= T && (r.removed_at === null || r.removed_at > T));
      return {
        id: s.id, label: s.label, createdTurn: s.created_turn,
        members: baseline.map(mapEntity),
        removedAfter: baseline.filter((r) => r.removed_at !== null).map(mapEntity),
        addedAfter: rows.filter((r) => r.added_at > T && r.removed_at === null).map(mapEntity),
      };
    }).filter((s) => byId.has(s.createdTurn) || s.members.length || s.addedAfter.length);
  }
}

function mapTurn(r: Row): Turn {
  return {
    id: r.id, sessionId: r.session_id, userId: r.user_id, askedAt: r.asked_at, answeredAt: r.answered_at, tz: r.tz,
    localDate: r.local_date, localDow: r.local_dow, userText: r.user_text, answerText: r.answer_text, route: r.route,
    topic: r.topic, status: r.status, extraction: r.extraction,
  };
}
function mapEntity(r: Row): Entity {
  return { id: r.id, name: r.name, kind: r.kind, aliases: JSON.parse(r.aliases), officialDomain: r.official_domain };
}
function mapEvidence(r: Row): Evidence {
  return {
    id: r.id, turnId: r.turn_id, url: r.url, title: r.title, chunk: r.chunk, chunkHash: r.chunk_hash,
    fetchedAt: r.fetched_at, publishedAt: r.published_at, via: r.via,
  };
}
