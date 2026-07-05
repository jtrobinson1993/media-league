import type { FastifyInstance } from 'fastify';
import { requireUser } from '../app.js';
import { leagueRole, httpError } from '../lib/permissions.js';
import { getLeague } from './leagues.js';

interface ResultRow {
  roundNumber: number;
  prompt: string | null;
  phase: string;
  title: string;
  year: number | null;
  submitter: string;
  score: number | null;
  placement: number | null;
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]!);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvEscape(r[c])).join(','))].join('\n') + '\n';
}

/** Per-league export of results + standings (SPEC §19, post-v1 item). */
export function registerExportRoutes(app: FastifyInstance): void {
  const { db } = app.ctx;

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    '/api/leagues/:id/export',
    async (req, reply) => {
      const user = requireUser(req);
      const league = getLeague(db, Number(req.params.id));
      if (!league) throw httpError(404, 'league not found');
      if (!leagueRole(db, league.id, user.id)) throw httpError(403, 'league member required');

      const results = db
        .prepare(
          `SELECT r.number AS roundNumber, r.prompt_title AS prompt, r.phase,
                  s.title, s.year, u.username AS submitter, rr.score, rr.placement
           FROM rounds r
           JOIN submissions s ON s.round_id = r.id
           JOIN users u ON u.id = s.user_id
           LEFT JOIN round_results rr ON rr.submission_id = s.id
           WHERE r.league_id = ? AND r.phase IN ('finished','voided')
           ORDER BY r.number, rr.placement`,
        )
        .all(league.id) as ResultRow[];

      const standings = db
        .prepare(
          `SELECT u.username, COALESCE(SUM(rr.score), 0) AS points,
                  COUNT(DISTINCT CASE WHEN rr.placement = 1 THEN rr.round_id END) AS wins,
                  COUNT(DISTINCT s.round_id) AS roundsPlayed
           FROM league_members lm JOIN users u ON u.id = lm.user_id
           LEFT JOIN submissions s ON s.user_id = u.id
             AND s.round_id IN (SELECT id FROM rounds WHERE league_id = ?)
           LEFT JOIN round_results rr ON rr.submission_id = s.id
           WHERE lm.league_id = ? AND lm.status = 'active'
           GROUP BY u.id ORDER BY points DESC`,
        )
        .all(league.id, league.id) as Record<string, unknown>[];

      const slug = league.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (req.query.format === 'csv') {
        const csv =
          `# ${league.name} — standings\n` +
          toCsv(standings) +
          `\n# ${league.name} — round results\n` +
          toCsv(results as unknown as Record<string, unknown>[]);
        return reply
          .type('text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="${slug}-export.csv"`)
          .send(csv);
      }

      reply.header('content-disposition', `attachment; filename="${slug}-export.json"`);
      return {
        league: { id: league.id, name: league.name, mediaType: league.media_type },
        exportedAt: Date.now(),
        standings,
        results,
      };
    },
  );
}
