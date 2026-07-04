import type { ScheduleTemplate } from '@media-league/shared';
import type { DB } from '../db.js';

export interface RoundRow {
  id: number;
  league_id: number;
  number: number;
  prompt_title: string | null;
  prompt_description: string | null;
  prompt_author_id: number | null;
  chooser_id: number | null;
  phase: 'scheduled' | 'submitting' | 'voting' | 'finished' | 'voided';
  submit_open_at: number;
  submit_close_at: number;
  vote_open_at: number;
  vote_close_at: number;
  voting_config: string;
  finalized_at: number | null;
}

export function getRound(db: DB, id: number): RoundRow | null {
  return (db.prepare('SELECT * FROM rounds WHERE id = ?').get(id) as RoundRow | undefined) ?? null;
}

/** Compute the next round's windows from a template, starting after `afterMs`. */
export function windowsFromTemplate(
  template: ScheduleTemplate,
  afterMs: number,
): { submitOpenAt: number; submitCloseAt: number; voteOpenAt: number; voteCloseAt: number } {
  const [hh, mm] = template.startTime.split(':').map(Number);
  const d = new Date(afterMs);
  d.setHours(hh ?? 0, mm ?? 0, 0, 0);
  // ISO weekday 1-7 (Mon-Sun); JS getDay() 0-6 (Sun-Sat).
  const isoDay = ((d.getDay() + 6) % 7) + 1;
  let deltaDays = (template.startWeekday - isoDay + 7) % 7;
  if (deltaDays === 0 && d.getTime() <= afterMs) deltaDays = 7;
  d.setDate(d.getDate() + deltaDays);

  const submitOpenAt = d.getTime();
  const submitCloseAt = submitOpenAt + template.submissionDays * 86_400_000;
  const voteCloseAt = submitCloseAt + template.votingDays * 86_400_000;
  return { submitOpenAt, submitCloseAt, voteOpenAt: submitCloseAt, voteCloseAt };
}

export interface TransitionEvent {
  round: RoundRow;
  from: RoundRow['phase'];
  to: RoundRow['phase'];
}

export type FinalizeHook = (db: DB, round: RoundRow) => void;

let finalizeHook: FinalizeHook = () => {};
/** Scoring registers itself here (keeps lifecycle free of scoring deps). */
export function setFinalizeHook(hook: FinalizeHook): void {
  finalizeHook = hook;
}

let transitionHook: (db: DB, ev: TransitionEvent) => void = () => {};
/** Notifications/webhooks hook into phase transitions (set once per app). */
export function setTransitionHook(hook: (db: DB, ev: TransitionEvent) => void): void {
  transitionHook = hook;
}

function emit(db: DB, ev: TransitionEvent): void {
  transitionHook(db, ev);
}

function setPhase(db: DB, round: RoundRow, to: RoundRow['phase']): void {
  const from = round.phase;
  db.prepare('UPDATE rounds SET phase = ? WHERE id = ?').run(to, round.id);
  round.phase = to;
  emit(db, { round, from, to });
}

function submissionCount(db: DB, roundId: number): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE round_id = ?').get(roundId) as { n: number }).n;
}

function ballotCount(db: DB, roundId: number): number {
  return (db.prepare('SELECT COUNT(DISTINCT voter_id) AS n FROM votes WHERE round_id = ?').get(roundId) as { n: number }).n;
}

/**
 * Advance a single round according to the clock (SPEC §10).
 * Returns true if a transition happened (callers loop until stable).
 */
export function tickRound(db: DB, round: RoundRow, now: number): boolean {
  switch (round.phase) {
    case 'scheduled': {
      if (now < round.submit_open_at) return false;
      // Winner-picks-next: a round cannot open without a prompt. Authorship
      // falls back to the admin (chooser cleared); it opens once a prompt exists.
      if (!round.prompt_title) {
        if (round.chooser_id !== null) {
          db.prepare('UPDATE rounds SET chooser_id = NULL WHERE id = ?').run(round.id);
          round.chooser_id = null;
        }
        return false;
      }
      setPhase(db, round, 'submitting');
      return true;
    }
    case 'submitting': {
      if (now < round.submit_close_at) return false;
      if (submissionCount(db, round.id) < 2) {
        setPhase(db, round, 'voided'); // SPEC §10: <2 submissions ⇒ VOID
        return true;
      }
      setPhase(db, round, 'voting');
      return true;
    }
    case 'voting': {
      if (now < round.vote_close_at) return false;
      if (ballotCount(db, round.id) === 0) {
        setPhase(db, round, 'voided'); // SPEC §10: zero ballots ⇒ VOID
        return true;
      }
      db.prepare('UPDATE rounds SET finalized_at = ? WHERE id = ?').run(now, round.id);
      round.finalized_at = now;
      finalizeHook(db, round);
      setPhase(db, round, 'finished');
      return true;
    }
    default:
      return false;
  }
}

/** Scan all live rounds and apply due transitions. Called by the scheduler. */
export function tickAll(db: DB, now = Date.now()): number {
  const live = db
    .prepare("SELECT * FROM rounds WHERE phase IN ('scheduled','submitting','voting')")
    .all() as RoundRow[];
  let transitions = 0;
  for (const round of live) {
    while (tickRound(db, round, now)) transitions++;
  }
  return transitions;
}

/**
 * Manual admin override (SPEC §10): jump to the next phase now by pulling the
 * relevant boundary to `now`, then ticking. Void rules still apply.
 */
export function advanceRound(db: DB, round: RoundRow, now = Date.now()): RoundRow {
  if (round.phase === 'scheduled') {
    db.prepare('UPDATE rounds SET submit_open_at = ? WHERE id = ? ').run(now, round.id);
    round.submit_open_at = now;
  } else if (round.phase === 'submitting') {
    db.prepare('UPDATE rounds SET submit_close_at = ?, vote_open_at = ? WHERE id = ?').run(now, now, round.id);
    round.submit_close_at = now;
    round.vote_open_at = now;
  } else if (round.phase === 'voting') {
    db.prepare('UPDATE rounds SET vote_close_at = ? WHERE id = ?').run(now, round.id);
    round.vote_close_at = now;
  }
  while (tickRound(db, round, now)) {
    /* run transitions to a stable state */
  }
  return round;
}

export function startScheduler(db: DB, intervalMs = 30_000): NodeJS.Timeout {
  const timer = setInterval(() => tickAll(db), intervalMs);
  timer.unref();
  return timer;
}
