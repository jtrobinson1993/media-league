import type { CoinRewards } from '@media-league/shared';
import type { DB } from '../db.js';
import type { RoundRow } from './roundLifecycle.js';
import { ballotEntries } from './ballots.js';

/**
 * Finalize a finished round (SPEC §12/§15):
 *  - tally merged entries; standard competition placements (ties share, 1-1-3)
 *  - materialize round_results (every underlying submission gets the entry's
 *    full score/placement ⇒ co-submitters get full credit)
 *  - award coins: participation + podium (ties get the full placement amount)
 *  - winner-picks-next: randomly designate a chooser among the winners and
 *    attach them to the league's next un-prompted scheduled round
 */
export function finalizeRound(db: DB, round: RoundRow, rewards: CoinRewards): void {
  const entries = ballotEntries(db, round.id);
  const scores = new Map<number, number>();
  for (const e of entries) scores.set(e.id, 0);
  const votes = db
    .prepare('SELECT submission_id, SUM(points) AS pts FROM votes WHERE round_id = ? GROUP BY submission_id')
    .all(round.id) as { submission_id: number; pts: number }[];
  for (const v of votes) if (scores.has(v.submission_id)) scores.set(v.submission_id, v.pts);

  const ranked = [...entries].sort((a, b) => scores.get(b.id)! - scores.get(a.id)!);
  const placements = new Map<number, number>(); // entry id -> placement
  let place = 0;
  let prevScore: number | null = null;
  ranked.forEach((e, i) => {
    const s = scores.get(e.id)!;
    if (s !== prevScore) {
      place = i + 1; // standard competition ranking: 1,1,3
      prevScore = s;
    }
    placements.set(e.id, place);
  });

  const insertResult = db.prepare(
    'INSERT OR REPLACE INTO round_results (round_id, submission_id, score, placement) VALUES (?, ?, ?, ?)',
  );
  const addCoins = db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?');
  const ledger = db.prepare(
    'INSERT INTO coin_ledger (user_id, round_id, amount, reason, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const now = Date.now();

  const txn = db.transaction(() => {
    const rewarded = new Set<number>();
    for (const e of entries) {
      const score = scores.get(e.id)!;
      const placement = placements.get(e.id)!;
      // Full credit for every underlying submission (merged dupes included).
      const subs = db
        .prepare('SELECT id, user_id FROM submissions WHERE round_id = ? AND (id = ? OR (provider_type IS NOT NULL AND provider_type = ? AND external_id = ?))')
        .all(round.id, e.id, e.provider_type, e.external_id) as { id: number; user_id: number }[];
      for (const s of subs) {
        insertResult.run(round.id, s.id, score, placement);
        if (rewarded.has(s.user_id)) continue;
        rewarded.add(s.user_id);
        let amount = rewards.participation;
        let reason = 'participation';
        if (placement <= 3) {
          amount += rewards.podium[placement - 1] ?? 0;
          reason = `participation+podium-${placement}`;
        }
        if (amount > 0) {
          addCoins.run(amount, s.user_id);
          ledger.run(s.user_id, round.id, amount, reason, now);
        }
      }
    }

    // Winner-picks-next (SPEC §9): random chooser among the winning entry's
    // submitters (co-winners/co-submitters all eligible).
    const league = db.prepare('SELECT prompt_mode FROM leagues WHERE id = ?').get(round.league_id) as {
      prompt_mode: string;
    };
    if (league.prompt_mode === 'winner-picks-next') {
      const winners = entries.filter((e) => placements.get(e.id) === 1).flatMap((e) => e.submitterIds);
      if (winners.length > 0) {
        const chooser = winners[Math.floor(Math.random() * winners.length)]!;
        const next = db
          .prepare(
            `SELECT id FROM rounds WHERE league_id = ? AND number > ? AND phase = 'scheduled'
               AND prompt_title IS NULL ORDER BY number LIMIT 1`,
          )
          .get(round.league_id, round.number) as { id: number } | undefined;
        if (next) db.prepare('UPDATE rounds SET chooser_id = ? WHERE id = ?').run(chooser, next.id);
      }
    }
  });
  txn();
}
