import type { FastifyInstance } from 'fastify';
import type { VotingConfig } from '@media-league/shared';
import { requireUser } from '../app.js';
import { leagueRole, httpError } from '../lib/permissions.js';
import { getLeague } from './leagues.js';
import { getRound } from '../lib/roundLifecycle.js';
import { ballotEntries, eligibleEntries, saveBallot } from '../lib/ballots.js';

export function registerVoteRoutes(app: FastifyInstance): void {
  const { db } = app.ctx;

  function loadVotingRound(roundId: number, userId: number) {
    const round = getRound(db, roundId);
    if (!round) throw httpError(404, 'round not found');
    if (!leagueRole(db, round.league_id, userId)) throw httpError(403, 'league member required');
    return round;
  }

  function checkEligibility(roundId: number, userId: number): void {
    const round = getRound(db, roundId)!;
    const league = getLeague(db, round.league_id)!;
    if (league.require_submission_to_vote) {
      const mine = db
        .prepare('SELECT 1 FROM submissions WHERE round_id = ? AND user_id = ?')
        .get(round.id, userId);
      if (!mine) throw httpError(403, 'you must submit to vote in this round');
    }
  }

  // The voter's ballot view: eligible entries + their current votes/notes.
  app.get<{ Params: { id: string } }>('/api/rounds/:id/ballot', async (req, reply) => {
    const user = requireUser(req);
    const round = loadVotingRound(Number(req.params.id), user.id);
    if (round.phase !== 'voting') return reply.code(400).send({ error: 'voting is not open' });
    checkEligibility(round.id, user.id);

    const cfg = JSON.parse(round.voting_config) as VotingConfig;
    const entries = eligibleEntries(ballotEntries(db, round.id), user.id, cfg);
    const myVotes = db
      .prepare('SELECT submission_id AS submissionId, points, rank, note FROM votes WHERE round_id = ? AND voter_id = ?')
      .all(round.id, user.id);
    return {
      votingConfig: cfg,
      items: entries
        .sort((a, b) => ((a.id * 2654435761) % 97) - ((b.id * 2654435761) % 97) || a.id - b.id)
        .map((e) => ({
          id: e.id,
          title: e.title,
          subtitle: e.subtitle,
          year: e.year,
          imageUrl: e.image_url,
          isFreeText: e.provider_type === null,
        })),
      myVotes,
    };
  });

  app.put<{ Params: { id: string }; Body: { allocations?: unknown; ranks?: unknown } }>(
    '/api/rounds/:id/ballot',
    async (req, reply) => {
      const user = requireUser(req);
      const round = loadVotingRound(Number(req.params.id), user.id);
      if (round.phase !== 'voting') return reply.code(400).send({ error: 'voting is not open' });
      checkEligibility(round.id, user.id);

      const cfg = JSON.parse(round.voting_config) as VotingConfig;
      saveBallot(db, round, user.id, cfg, req.body ?? {});
      return { ok: true };
    },
  );

  // Results: totals + per-voter breakdown + notes, full attribution (SPEC §12).
  app.get<{ Params: { id: string } }>('/api/rounds/:id/results', async (req, reply) => {
    const user = requireUser(req);
    const round = loadVotingRound(Number(req.params.id), user.id);
    if (round.phase === 'voided') return { phase: 'voided' };
    if (round.phase !== 'finished') return reply.code(400).send({ error: 'results are not ready' });

    const users = new Map(
      (
        db
          .prepare('SELECT id, username, display_name AS displayName FROM users')
          .all() as { id: number; username: string; displayName: string | null }[]
      ).map((u) => [u.id, u]),
    );

    const entries = ballotEntries(db, round.id);
    const results = db
      .prepare('SELECT submission_id, score, placement FROM round_results WHERE round_id = ?')
      .all(round.id) as { submission_id: number; score: number; placement: number }[];
    const byEntry = new Map(results.map((r) => [r.submission_id, r]));

    const votes = db
      .prepare('SELECT submission_id, voter_id, points, rank, note FROM votes WHERE round_id = ? ORDER BY points DESC')
      .all(round.id) as { submission_id: number; voter_id: number; points: number; rank: number | null; note: string | null }[];

    const items = entries
      .map((e) => ({
        id: e.id,
        title: e.title,
        subtitle: e.subtitle,
        year: e.year,
        imageUrl: e.image_url,
        isFreeText: e.provider_type === null,
        score: byEntry.get(e.id)?.score ?? 0,
        placement: byEntry.get(e.id)?.placement ?? null,
        submitters: e.submitterIds.map((id) => users.get(id) ?? null),
        votes: votes
          .filter((v) => v.submission_id === e.id)
          .map((v) => ({ voter: users.get(v.voter_id) ?? null, points: v.points, rank: v.rank, note: v.note })),
      }))
      .sort((a, b) => (a.placement ?? 999) - (b.placement ?? 999) || b.score - a.score);

    return { phase: 'finished', items };
  });

  // League standings: sum of a player's round scores (SPEC §12/§16).
  app.get<{ Params: { id: string } }>('/api/leagues/:id/standings', async (req) => {
    const user = requireUser(req);
    const league = getLeague(db, Number(req.params.id));
    if (!league) throw httpError(404, 'league not found');
    if (!leagueRole(db, league.id, user.id)) throw httpError(403, 'league member required');

    const rows = db
      .prepare(
        `SELECT u.id, u.username, u.display_name AS displayName,
                COALESCE(SUM(rr.score), 0) AS points,
                COUNT(DISTINCT CASE WHEN rr.placement = 1 THEN rr.round_id END) AS wins,
                COUNT(DISTINCT s.round_id) AS roundsPlayed
         FROM league_members lm
         JOIN users u ON u.id = lm.user_id
         LEFT JOIN submissions s ON s.user_id = u.id
           AND s.round_id IN (SELECT id FROM rounds WHERE league_id = ?)
         LEFT JOIN round_results rr ON rr.submission_id = s.id
         WHERE lm.league_id = ? AND lm.status = 'active'
         GROUP BY u.id ORDER BY points DESC, u.username`,
      )
      .all(league.id, league.id) as { id: number; username: string; displayName: string | null; points: number; wins: number; roundsPlayed: number }[];

    // Ties share a rank (co-champions, SPEC §12).
    let rank = 0;
    let prev: number | null = null;
    const standings = rows.map((r, i) => {
      if (r.points !== prev) {
        rank = i + 1;
        prev = r.points;
      }
      return { ...r, rank };
    });
    return { standings };
  });
}
