import type { DB } from '../db.js';
import type { TransitionEvent } from './roundLifecycle.js';
import { notify, leagueMemberIds } from './notifications.js';
import { dispatchWebhooks, type WebhookData } from './webhooks.js';

const REMINDER_WINDOW_MS = 2 * 3_600_000; // "closes in 2 hours" (SPEC §14)

/**
 * Fan a round phase transition out to in-app notifications, web push, and
 * league webhooks (SPEC §14). Registered as the lifecycle transition hook.
 */
export function handleTransition(db: DB, ev: TransitionEvent): void {
  const { round, to } = ev;
  const league = db.prepare('SELECT id, name FROM leagues WHERE id = ?').get(round.league_id) as
    | { id: number; name: string }
    | undefined;
  if (!league) return; // league deleted mid-flight

  const audience = leagueMemberIds(db, league.id);
  const base: WebhookData = { leagueName: league.name, roundNumber: round.number, prompt: round.prompt_title };
  const ctx = { leagueId: league.id, roundId: round.id };

  switch (to) {
    case 'submitting': {
      notify(db, audience, 'submissions.open', {
        title: `Submissions open: ${league.name}`,
        body: round.prompt_title ?? undefined,
        ...ctx,
      });
      dispatchWebhooks(db, league.id, 'submissions.open', base);
      break;
    }
    case 'voting': {
      notify(db, audience, 'voting.open', {
        title: `Voting open: ${league.name}`,
        body: round.prompt_title ?? undefined,
        ...ctx,
      });
      dispatchWebhooks(db, league.id, 'submissions.closed', base);
      dispatchWebhooks(db, league.id, 'voting.open', base);
      break;
    }
    case 'finished': {
      notify(db, audience, 'results.posted', {
        title: `Results are up: ${league.name}`,
        body: round.prompt_title ?? undefined,
        ...ctx,
      });
      dispatchWebhooks(db, league.id, 'voting.closed', base);
      dispatchWebhooks(db, league.id, 'results.posted', base);

      const winners = db
        .prepare(
          `SELECT DISTINCT u.username FROM round_results rr
           JOIN submissions s ON s.id = rr.submission_id JOIN users u ON u.id = s.user_id
           WHERE rr.round_id = ? AND rr.placement = 1`,
        )
        .all(round.id) as { username: string }[];
      if (winners.length > 0) {
        dispatchWebhooks(db, league.id, 'winner.announced', {
          ...base,
          detail: `${winners.map((w) => w.username).join(' & ')} won`,
        });
      }

      // Winner-picks-next: scoring may have just designated a chooser.
      const next = db
        .prepare(
          `SELECT id, chooser_id FROM rounds WHERE league_id = ? AND phase = 'scheduled'
             AND chooser_id IS NOT NULL AND prompt_title IS NULL ORDER BY number LIMIT 1`,
        )
        .get(league.id) as { id: number; chooser_id: number } | undefined;
      if (next) {
        notify(db, [next.chooser_id], 'prompt.your-turn', {
          title: `You won! Pick the next prompt in ${league.name}`,
          leagueId: league.id,
          roundId: next.id,
        });
      }
      break;
    }
    case 'voided': {
      notify(db, audience, 'round.voided', {
        title: `Round voided: ${league.name}`,
        body: 'Not enough submissions or ballots.',
        ...ctx,
      });
      break;
    }
    default:
      break;
  }
}

/**
 * One-shot "closing soon" nudges (SPEC §14): sent once per phase when a round
 * is within the reminder window, only to members who haven't acted yet.
 * Called by the scheduler alongside tickAll.
 */
export function sendClosingReminders(db: DB, now = Date.now()): void {
  const soonSubmitting = db
    .prepare(
      `SELECT r.*, l.name AS league_name FROM rounds r JOIN leagues l ON l.id = r.league_id
       WHERE r.phase = 'submitting' AND r.submit_reminder_sent = 0
         AND r.submit_close_at - ? BETWEEN 0 AND ?`,
    )
    .all(now, REMINDER_WINDOW_MS) as (TransitionEvent['round'] & { league_name: string })[];
  for (const round of soonSubmitting) {
    const laggards = db
      .prepare(
        `SELECT user_id FROM league_members WHERE league_id = ? AND status = 'active'
           AND user_id NOT IN (SELECT user_id FROM submissions WHERE round_id = ?)`,
      )
      .all(round.league_id, round.id) as { user_id: number }[];
    notify(db, laggards.map((l) => l.user_id), 'submissions.closing', {
      title: `Submissions close soon: ${round.league_name}`,
      body: round.prompt_title ?? undefined,
      leagueId: round.league_id,
      roundId: round.id,
    });
    db.prepare('UPDATE rounds SET submit_reminder_sent = 1 WHERE id = ?').run(round.id);
  }

  const soonVoting = db
    .prepare(
      `SELECT r.*, l.name AS league_name FROM rounds r JOIN leagues l ON l.id = r.league_id
       WHERE r.phase = 'voting' AND r.vote_reminder_sent = 0
         AND r.vote_close_at - ? BETWEEN 0 AND ?`,
    )
    .all(now, REMINDER_WINDOW_MS) as (TransitionEvent['round'] & { league_name: string })[];
  for (const round of soonVoting) {
    const laggards = db
      .prepare(
        `SELECT user_id FROM league_members WHERE league_id = ? AND status = 'active'
           AND user_id NOT IN (SELECT DISTINCT voter_id FROM votes WHERE round_id = ?)`,
      )
      .all(round.league_id, round.id) as { user_id: number }[];
    notify(db, laggards.map((l) => l.user_id), 'voting.closing', {
      title: `Voting closes soon: ${round.league_name}`,
      body: round.prompt_title ?? undefined,
      leagueId: round.league_id,
      roundId: round.id,
    });
    db.prepare('UPDATE rounds SET vote_reminder_sent = 1 WHERE id = ?').run(round.id);
  }
}
