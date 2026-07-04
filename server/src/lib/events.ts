import type { DB } from '../db.js';
import type { TransitionEvent } from './roundLifecycle.js';
import { notify, leagueMemberIds } from './notifications.js';
import { dispatchWebhooks, type WebhookData } from './webhooks.js';

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
