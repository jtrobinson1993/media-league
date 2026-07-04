import type { FastifyInstance } from 'fastify';
import type { ScheduleTemplate } from '@media-league/shared';
import { requireUser } from '../app.js';
import { leagueRole, httpError } from '../lib/permissions.js';
import { parseVotingConfig } from '../lib/votingConfig.js';
import { getLeague } from './leagues.js';
import { getRound, windowsFromTemplate, advanceRound, tickAll, type RoundRow } from '../lib/roundLifecycle.js';

function requireLeagueAdmin(db: FastifyInstance['ctx']['db'], leagueId: number, userId: number): void {
  if (leagueRole(db, leagueId, userId) !== 'admin') throw httpError(403, 'league admin required');
}

function roundJson(r: RoundRow): Record<string, unknown> {
  return {
    id: r.id,
    leagueId: r.league_id,
    number: r.number,
    promptTitle: r.prompt_title,
    promptDescription: r.prompt_description,
    chooserId: r.chooser_id,
    phase: r.phase,
    submitOpenAt: r.submit_open_at,
    submitCloseAt: r.submit_close_at,
    voteOpenAt: r.vote_open_at,
    voteCloseAt: r.vote_close_at,
    votingConfig: JSON.parse(r.voting_config),
  };
}

export function registerRoundRoutes(app: FastifyInstance): void {
  const { db } = app.ctx;

  // Create one or more rounds; windows auto-fill from the template + previous
  // round (SPEC §16 scheduling UX), or come explicitly in the body.
  app.post<{
    Params: { id: string };
    Body: {
      count?: number;
      promptTitle?: string;
      promptDescription?: string;
      votingConfig?: unknown;
      submitOpenAt?: number;
      submitCloseAt?: number;
      voteCloseAt?: number;
    };
  }>('/api/leagues/:id/rounds', async (req, reply) => {
    const user = requireUser(req);
    const league = getLeague(db, Number(req.params.id));
    if (!league) throw httpError(404, 'league not found');
    requireLeagueAdmin(db, league.id, user.id);

    const b = req.body ?? {};
    const count = b.count ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 30) return reply.code(400).send({ error: 'count 1-30' });

    const votingConfig = b.votingConfig ? parseVotingConfig(b.votingConfig) : JSON.parse(league.default_voting_config);
    if (!votingConfig) return reply.code(400).send({ error: 'bad votingConfig' });

    const template = league.schedule_template
      ? (JSON.parse(league.schedule_template) as ScheduleTemplate)
      : null;

    const explicit =
      b.submitOpenAt !== undefined || b.submitCloseAt !== undefined || b.voteCloseAt !== undefined;
    if (explicit) {
      if (count !== 1) return reply.code(400).send({ error: 'explicit dates only with count=1' });
      if (
        typeof b.submitOpenAt !== 'number' ||
        typeof b.submitCloseAt !== 'number' ||
        typeof b.voteCloseAt !== 'number' ||
        !(b.submitOpenAt < b.submitCloseAt && b.submitCloseAt <= b.voteCloseAt)
      ) {
        return reply.code(400).send({ error: 'need submitOpenAt < submitCloseAt <= voteCloseAt' });
      }
    } else if (!template) {
      return reply.code(400).send({ error: 'league has no schedule template; pass explicit dates' });
    }

    const lastRow = db
      .prepare('SELECT MAX(number) AS n, MAX(submit_open_at) AS t FROM rounds WHERE league_id = ?')
      .get(league.id) as { n: number | null; t: number | null };
    let number = (lastRow.n ?? 0) + 1;
    let after = Math.max(lastRow.t ?? 0, Date.now());

    const created: RoundRow[] = [];
    const insert = db.prepare(
      `INSERT INTO rounds (league_id, number, prompt_title, prompt_description, prompt_author_id,
         submit_open_at, submit_close_at, vote_open_at, vote_close_at, voting_config)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const txn = db.transaction(() => {
      for (let i = 0; i < count; i++) {
        const w = explicit
          ? {
              submitOpenAt: b.submitOpenAt!,
              submitCloseAt: b.submitCloseAt!,
              voteOpenAt: b.submitCloseAt!,
              voteCloseAt: b.voteCloseAt!,
            }
          : windowsFromTemplate(template!, after);
        // Prompt only applies to the first created round; the rest are queued
        // unset (admin pre-enters later, or winner picks — SPEC §9).
        const title = i === 0 ? (b.promptTitle?.trim() || null) : null;
        const info = insert.run(
          league.id,
          number,
          title,
          i === 0 ? (b.promptDescription?.trim() || null) : null,
          title ? user.id : null,
          w.submitOpenAt,
          w.submitCloseAt,
          w.voteOpenAt,
          w.voteCloseAt,
          JSON.stringify(votingConfig),
        );
        created.push(getRound(db, Number(info.lastInsertRowid))!);
        number++;
        after = w.submitOpenAt;
      }
    });
    txn();
    tickAll(db); // open immediately if the window has already started
    return { rounds: created.map((r) => roundJson(getRound(db, r.id)!)) };
  });

  app.get<{ Params: { id: string } }>('/api/leagues/:id/rounds', async (req) => {
    const user = requireUser(req);
    const league = getLeague(db, Number(req.params.id));
    if (!league) throw httpError(404, 'league not found');
    if (!leagueRole(db, league.id, user.id)) throw httpError(403, 'league member required');
    const rows = db
      .prepare('SELECT * FROM rounds WHERE league_id = ? ORDER BY number DESC')
      .all(league.id) as RoundRow[];
    return { rounds: rows.map(roundJson) };
  });

  app.get<{ Params: { id: string } }>('/api/rounds/:id', async (req) => {
    const user = requireUser(req);
    const round = getRound(db, Number(req.params.id));
    if (!round) throw httpError(404, 'round not found');
    if (!leagueRole(db, round.league_id, user.id)) throw httpError(403, 'league member required');
    return { round: roundJson(round) };
  });

  // Edit prompt/dates/config. Prompt may also be set by the designated chooser
  // (winner-picks-next), but only while the round hasn't opened.
  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/rounds/:id', async (req, reply) => {
    const user = requireUser(req);
    const round = getRound(db, Number(req.params.id));
    if (!round) throw httpError(404, 'round not found');

    const isAdmin = leagueRole(db, round.league_id, user.id) === 'admin';
    const isChooser = round.chooser_id === user.id;
    if (!isAdmin && !isChooser) throw httpError(403, 'league admin or chooser required');

    const b = req.body ?? {};
    const sets: string[] = [];
    const vals: unknown[] = [];

    if (typeof b.promptTitle === 'string' && b.promptTitle.trim()) {
      if (round.phase !== 'scheduled' && !isAdmin) throw httpError(400, 'prompt is locked once the round opens');
      sets.push('prompt_title = ?', 'prompt_author_id = ?');
      vals.push(b.promptTitle.trim(), user.id);
      if (typeof b.promptDescription === 'string') {
        sets.push('prompt_description = ?');
        vals.push(b.promptDescription.trim() || null);
      }
    }

    if (isAdmin) {
      for (const [key, col] of [
        ['submitOpenAt', 'submit_open_at'],
        ['submitCloseAt', 'submit_close_at'],
        ['voteCloseAt', 'vote_close_at'],
      ] as const) {
        if (typeof b[key] === 'number') {
          sets.push(`${col} = ?`);
          vals.push(b[key]);
          if (key === 'submitCloseAt') {
            sets.push('vote_open_at = ?');
            vals.push(b[key]);
          }
        }
      }
      if (b.votingConfig !== undefined) {
        if (round.phase === 'voting' || round.phase === 'finished') {
          return reply.code(400).send({ error: 'voting config locked once voting opens' });
        }
        const cfg = parseVotingConfig(b.votingConfig);
        if (!cfg) return reply.code(400).send({ error: 'bad votingConfig' });
        sets.push('voting_config = ?');
        vals.push(JSON.stringify(cfg));
      }
    }

    if (sets.length === 0) return reply.code(400).send({ error: 'nothing to update' });
    db.prepare(`UPDATE rounds SET ${sets.join(', ')} WHERE id = ?`).run(...vals, round.id);
    tickAll(db);
    return { round: roundJson(getRound(db, round.id)!) };
  });

  // Manual override: advance to the next phase now (SPEC §10).
  app.post<{ Params: { id: string } }>('/api/rounds/:id/advance', async (req, reply) => {
    const user = requireUser(req);
    const round = getRound(db, Number(req.params.id));
    if (!round) throw httpError(404, 'round not found');
    requireLeagueAdmin(db, round.league_id, user.id);
    if (round.phase === 'finished' || round.phase === 'voided') {
      return reply.code(400).send({ error: 'round is over' });
    }
    if (round.phase === 'scheduled' && !round.prompt_title) {
      return reply.code(400).send({ error: 'set a prompt before opening submissions' });
    }
    advanceRound(db, round);
    return { round: roundJson(getRound(db, round.id)!) };
  });

  app.delete<{ Params: { id: string } }>('/api/rounds/:id', async (req, reply) => {
    const user = requireUser(req);
    const round = getRound(db, Number(req.params.id));
    if (!round) throw httpError(404, 'round not found');
    requireLeagueAdmin(db, round.league_id, user.id);
    if (round.phase !== 'scheduled') return reply.code(400).send({ error: 'only scheduled rounds can be deleted' });
    db.prepare('DELETE FROM rounds WHERE id = ?').run(round.id);
    return { ok: true };
  });
}
