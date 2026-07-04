import type { VotingConfig } from '@media-league/shared';
import { resolveRankWeights } from '@media-league/shared';
import type { DB } from '../db.js';
import type { RoundRow } from './roundLifecycle.js';
import { httpError } from './permissions.js';

export interface SubmissionRow {
  id: number;
  round_id: number;
  user_id: number;
  provider_type: string | null;
  external_id: string | null;
  title: string;
  subtitle: string | null;
  year: number | null;
  image_url: string | null;
}

/**
 * A ballot entry: one votable item. Duplicate provider items are merged into
 * a single entry (SPEC §11); its id is the lowest submission id of the set.
 */
export interface BallotEntry extends SubmissionRow {
  submitterIds: number[];
}

export function ballotEntries(db: DB, roundId: number): BallotEntry[] {
  const all = db
    .prepare('SELECT * FROM submissions WHERE round_id = ? ORDER BY id')
    .all(roundId) as SubmissionRow[];
  const merged = new Map<string, BallotEntry>();
  for (const s of all) {
    const key = s.provider_type ? `${s.provider_type}:${s.external_id}` : `sub:${s.id}`;
    const existing = merged.get(key);
    if (existing) existing.submitterIds.push(s.user_id);
    else merged.set(key, { ...s, submitterIds: [s.user_id] });
  }
  return [...merged.values()];
}

/** Entries this voter may vote on (self-vote exclusion per config). */
export function eligibleEntries(entries: BallotEntry[], voterId: number, cfg: VotingConfig): BallotEntry[] {
  return cfg.allowSelfVote ? entries : entries.filter((e) => !e.submitterIds.includes(voterId));
}

export interface PoolAllocation {
  submissionId: number;
  points: number;
  note?: string;
}

export interface RankAllocation {
  submissionId: number;
  rank: number;
  note?: string;
}

function checkNote(note: unknown): string | null {
  if (note === undefined || note === null || note === '') return null;
  if (typeof note !== 'string' || note.length > 500) throw httpError(400, 'note must be a string (max 500 chars)');
  return note;
}

/**
 * Validate a ballot against the round's voting config and replace the voter's
 * votes atomically. Throws httpError(400) on any violation.
 */
export function saveBallot(
  db: DB,
  round: RoundRow,
  voterId: number,
  cfg: VotingConfig,
  body: { allocations?: unknown; ranks?: unknown },
): void {
  const entries = eligibleEntries(ballotEntries(db, round.id), voterId, cfg);
  const eligibleIds = new Set(entries.map((e) => e.id));

  interface VoteRow {
    submissionId: number;
    points: number;
    rank: number | null;
    note: string | null;
  }
  const rows: VoteRow[] = [];

  if (cfg.method === 'pool') {
    if (!Array.isArray(body.allocations)) throw httpError(400, 'allocations[] required');
    const cap = Math.min(cfg.perItemCap ?? cfg.totalPoints, cfg.totalPoints);
    const seen = new Set<number>();
    let sum = 0;
    for (const raw of body.allocations) {
      const a = raw as PoolAllocation;
      if (!eligibleIds.has(a.submissionId)) throw httpError(400, 'invalid ballot target');
      if (seen.has(a.submissionId)) throw httpError(400, 'duplicate ballot target');
      seen.add(a.submissionId);
      if (!Number.isInteger(a.points) || a.points < 1) throw httpError(400, 'points must be positive integers');
      if (a.points > cap) throw httpError(400, `max ${cap} points per item`);
      sum += a.points;
      rows.push({ submissionId: a.submissionId, points: a.points, rank: null, note: checkNote(a.note) });
    }
    if (sum > cfg.totalPoints) throw httpError(400, `you have ${cfg.totalPoints} points to spend`);
    if (cfg.mustSpendAll) {
      // A voter can be unable to spend the pool when few items exist (cap ×
      // items < pool); require the spendable maximum instead of the raw pool.
      const spendable = Math.min(cfg.totalPoints, cap * entries.length);
      if (sum < spendable) throw httpError(400, `you must spend all ${spendable} available points`);
    }
    if (rows.length === 0) throw httpError(400, 'empty ballot');
  } else {
    if (!Array.isArray(body.ranks)) throw httpError(400, 'ranks[] required');
    const k = Math.min(cfg.numRanks, entries.length); // clamp (SPEC §12)
    const weights = resolveRankWeights(cfg);
    const seenIds = new Set<number>();
    const seenRanks = new Set<number>();
    for (const raw of body.ranks) {
      const r = raw as RankAllocation;
      if (!eligibleIds.has(r.submissionId)) throw httpError(400, 'invalid ballot target');
      if (seenIds.has(r.submissionId)) throw httpError(400, 'duplicate ballot target');
      seenIds.add(r.submissionId);
      if (!Number.isInteger(r.rank) || r.rank < 1 || r.rank > k) throw httpError(400, `rank must be 1-${k}`);
      if (seenRanks.has(r.rank)) throw httpError(400, 'duplicate rank');
      seenRanks.add(r.rank);
      const weight = weights[r.rank - 1] ?? 0;
      rows.push({ submissionId: r.submissionId, points: weight, rank: r.rank, note: checkNote(r.note) });
    }
    if (cfg.mustFillAllRanks && rows.length < k) throw httpError(400, `you must fill all ${k} ranks`);
    if (rows.length === 0) throw httpError(400, 'empty ballot');
  }

  const txn = db.transaction(() => {
    db.prepare('DELETE FROM votes WHERE round_id = ? AND voter_id = ?').run(round.id, voterId);
    const insert = db.prepare(
      'INSERT INTO votes (round_id, voter_id, submission_id, points, rank, note) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const r of rows) insert.run(round.id, voterId, r.submissionId, r.points, r.rank, r.note);
  });
  txn();
}
