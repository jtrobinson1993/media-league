import type { FastifyInstance } from 'fastify';
import { DEFAULT_POOL_CONFIG, type ScheduleTemplate } from '@media-league/shared';
import { requireUser } from '../app.js';
import { groupRole, leagueRole, requireGroupMember, httpError } from '../lib/permissions.js';
import { createInvite, standingInvite, regenerateStandingInvite } from '../lib/invites.js';
import { joinLeague, setLeagueMemberStatus } from '../lib/memberships.js';
import { parseVotingConfig } from '../lib/votingConfig.js';

interface LeagueRow {
  id: number;
  group_id: number;
  name: string;
  media_type: string;
  visibility: 'public' | 'private';
  allow_duplicates: number;
  require_submission_to_vote: number;
  prompt_mode: 'admin' | 'winner-picks-next';
  schedule_template: string | null;
  default_voting_config: string;
}

function parseScheduleTemplate(input: unknown): ScheduleTemplate | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  const t = input as Record<string, unknown>;
  const startWeekday = Number(t.startWeekday);
  const submissionDays = Number(t.submissionDays);
  const votingDays = Number(t.votingDays);
  if (!Number.isInteger(startWeekday) || startWeekday < 1 || startWeekday > 7) return undefined;
  if (typeof t.startTime !== 'string' || !/^\d{2}:\d{2}$/.test(t.startTime)) return undefined;
  if (!Number.isFinite(submissionDays) || submissionDays <= 0 || submissionDays > 60) return undefined;
  if (!Number.isFinite(votingDays) || votingDays <= 0 || votingDays > 60) return undefined;
  return { startWeekday, startTime: t.startTime, submissionDays, votingDays };
}

export function getLeague(db: FastifyInstance['ctx']['db'], id: number): LeagueRow | null {
  return (db.prepare('SELECT * FROM leagues WHERE id = ?').get(id) as LeagueRow | undefined) ?? null;
}

/** Can this user see the league at all? Public ⇒ group members; private ⇒ league members. */
function canView(db: FastifyInstance['ctx']['db'], league: LeagueRow, userId: number): boolean {
  if (leagueRole(db, league.id, userId)) return true;
  return league.visibility === 'public' && groupRole(db, league.group_id, userId) !== null;
}

/** League admins run the league; group admins have moderation oversight (SPEC §13). */
function canModerate(db: FastifyInstance['ctx']['db'], league: LeagueRow, userId: number): boolean {
  return leagueRole(db, league.id, userId) === 'admin' || groupRole(db, league.group_id, userId) === 'admin';
}

export function registerLeagueRoutes(app: FastifyInstance): void {
  const { db } = app.ctx;

  app.post<{
    Params: { id: string };
    Body: {
      name?: string;
      visibility?: 'public' | 'private';
      allowDuplicates?: boolean;
      requireSubmissionToVote?: boolean;
      promptMode?: 'admin' | 'winner-picks-next';
      scheduleTemplate?: unknown;
      defaultVotingConfig?: unknown;
    };
  }>('/api/groups/:id/leagues', async (req, reply) => {
    const user = requireUser(req);
    const groupId = Number(req.params.id);
    requireGroupMember(db, groupId, user.id);

    const b = req.body ?? {};
    const name = b.name?.trim();
    if (!name || name.length > 80) return reply.code(400).send({ error: 'name required (max 80 chars)' });
    const visibility = b.visibility ?? 'public';
    if (visibility !== 'public' && visibility !== 'private') return reply.code(400).send({ error: 'bad visibility' });
    const promptMode = b.promptMode ?? 'admin';
    if (promptMode !== 'admin' && promptMode !== 'winner-picks-next') {
      return reply.code(400).send({ error: 'bad promptMode' });
    }
    const votingConfig = b.defaultVotingConfig ? parseVotingConfig(b.defaultVotingConfig) : DEFAULT_POOL_CONFIG;
    if (!votingConfig) return reply.code(400).send({ error: 'bad defaultVotingConfig' });
    const template = parseScheduleTemplate(b.scheduleTemplate ?? null);
    if (template === undefined && b.scheduleTemplate != null) {
      return reply.code(400).send({ error: 'bad scheduleTemplate' });
    }

    const info = db
      .prepare(
        `INSERT INTO leagues (group_id, name, media_type, visibility, allow_duplicates,
           require_submission_to_vote, prompt_mode, schedule_template, default_voting_config, created_by, created_at)
         VALUES (?, ?, 'movie', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        groupId,
        name,
        visibility,
        b.allowDuplicates ? 1 : 0,
        b.requireSubmissionToVote === false ? 0 : 1,
        promptMode,
        template ? JSON.stringify(template) : null,
        JSON.stringify(votingConfig),
        user.id,
        Date.now(),
      );
    const leagueId = Number(info.lastInsertRowid);
    joinLeague(db, leagueId, user.id, 'admin');
    createInvite(db, 'league', leagueId, 'standing', user.id);
    return { league: { id: leagueId, name, visibility } };
  });

  app.get<{ Params: { id: string } }>('/api/leagues/:id', async (req) => {
    const user = requireUser(req);
    const league = getLeague(db, Number(req.params.id));
    if (!league) throw httpError(404, 'league not found');
    if (!canView(db, league, user.id)) throw httpError(403, 'not visible to you');

    const members = db
      .prepare(
        `SELECT u.id, u.username, u.display_name AS displayName, lm.role
         FROM league_members lm JOIN users u ON u.id = lm.user_id
         WHERE lm.league_id = ? AND lm.status = 'active' ORDER BY u.username`,
      )
      .all(league.id);
    return {
      league: {
        id: league.id,
        groupId: league.group_id,
        name: league.name,
        mediaType: league.media_type,
        visibility: league.visibility,
        allowDuplicates: league.allow_duplicates === 1,
        requireSubmissionToVote: league.require_submission_to_vote === 1,
        promptMode: league.prompt_mode,
        scheduleTemplate: league.schedule_template ? JSON.parse(league.schedule_template) : null,
        defaultVotingConfig: JSON.parse(league.default_voting_config),
      },
      members,
      myRole: leagueRole(db, league.id, user.id),
      canModerate: canModerate(db, league, user.id),
    };
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/leagues/:id', async (req, reply) => {
    const user = requireUser(req);
    const league = getLeague(db, Number(req.params.id));
    if (!league) throw httpError(404, 'league not found');
    if (leagueRole(db, league.id, user.id) !== 'admin') throw httpError(403, 'league admin required');

    const b = req.body ?? {};
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (typeof b.name === 'string' && b.name.trim() && b.name.trim().length <= 80) {
      sets.push('name = ?');
      vals.push(b.name.trim());
    }
    if (b.visibility === 'public' || b.visibility === 'private') {
      sets.push('visibility = ?');
      vals.push(b.visibility);
    }
    if (typeof b.allowDuplicates === 'boolean') {
      sets.push('allow_duplicates = ?');
      vals.push(b.allowDuplicates ? 1 : 0);
    }
    if (typeof b.requireSubmissionToVote === 'boolean') {
      sets.push('require_submission_to_vote = ?');
      vals.push(b.requireSubmissionToVote ? 1 : 0);
    }
    if (b.promptMode === 'admin' || b.promptMode === 'winner-picks-next') {
      sets.push('prompt_mode = ?');
      vals.push(b.promptMode);
    }
    if (b.scheduleTemplate !== undefined) {
      const template = parseScheduleTemplate(b.scheduleTemplate);
      if (template === undefined && b.scheduleTemplate !== null) {
        return reply.code(400).send({ error: 'bad scheduleTemplate' });
      }
      sets.push('schedule_template = ?');
      vals.push(template ? JSON.stringify(template) : null);
    }
    if (b.defaultVotingConfig !== undefined) {
      const cfg = parseVotingConfig(b.defaultVotingConfig);
      if (!cfg) return reply.code(400).send({ error: 'bad defaultVotingConfig' });
      sets.push('default_voting_config = ?');
      vals.push(JSON.stringify(cfg));
    }
    if (sets.length === 0) return reply.code(400).send({ error: 'nothing to update' });
    db.prepare(`UPDATE leagues SET ${sets.join(', ')} WHERE id = ?`).run(...vals, league.id);
    return { ok: true };
  });

  // Group admin moderation oversight OR league admin: delete league.
  app.delete<{ Params: { id: string } }>('/api/leagues/:id', async (req) => {
    const user = requireUser(req);
    const league = getLeague(db, Number(req.params.id));
    if (!league) throw httpError(404, 'league not found');
    if (!canModerate(db, league, user.id)) throw httpError(403, 'admin required');
    db.prepare('DELETE FROM leagues WHERE id = ?').run(league.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/leagues/:id/join', async (req) => {
    const user = requireUser(req);
    const league = getLeague(db, Number(req.params.id));
    if (!league) throw httpError(404, 'league not found');
    requireGroupMember(db, league.group_id, user.id);
    if (league.visibility === 'private' && !leagueRole(db, league.id, user.id)) {
      throw httpError(403, 'private league — invite required');
    }
    joinLeague(db, league.id, user.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/leagues/:id/leave', async (req, reply) => {
    const user = requireUser(req);
    const league = getLeague(db, Number(req.params.id));
    if (!league) throw httpError(404, 'league not found');
    const admins = db
      .prepare("SELECT COUNT(*) AS n FROM league_members WHERE league_id = ? AND role = 'admin' AND status = 'active'")
      .get(league.id) as { n: number };
    if (leagueRole(db, league.id, user.id) === 'admin' && admins.n === 1) {
      return reply.code(400).send({ error: 'promote another admin before leaving' });
    }
    if (!setLeagueMemberStatus(db, league.id, user.id, 'left')) return reply.code(404).send({ error: 'not a member' });
    return { ok: true };
  });

  // Role change: league admins, plus group admins (reassign an abandoned league).
  app.post<{ Params: { id: string; userId: string }; Body: { role?: 'admin' | 'member' } }>(
    '/api/leagues/:id/members/:userId/role',
    async (req, reply) => {
      const user = requireUser(req);
      const league = getLeague(db, Number(req.params.id));
      if (!league) throw httpError(404, 'league not found');
      if (!canModerate(db, league, user.id)) throw httpError(403, 'admin required');
      const role = req.body?.role;
      if (role !== 'admin' && role !== 'member') return reply.code(400).send({ error: 'role must be admin|member' });
      const targetId = Number(req.params.userId);
      if (role === 'member') {
        const admins = db
          .prepare(
            "SELECT COUNT(*) AS n FROM league_members WHERE league_id = ? AND role = 'admin' AND status = 'active'",
          )
          .get(league.id) as { n: number };
        const targetRole = leagueRole(db, league.id, targetId);
        if (targetRole === 'admin' && admins.n === 1) {
          return reply.code(400).send({ error: 'cannot demote the last admin' });
        }
      }
      const info = db
        .prepare("UPDATE league_members SET role = ? WHERE league_id = ? AND user_id = ? AND status = 'active'")
        .run(role, league.id, targetId);
      if (info.changes === 0) return reply.code(404).send({ error: 'member not found' });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>('/api/leagues/:id/members/:userId', async (req, reply) => {
    const user = requireUser(req);
    const league = getLeague(db, Number(req.params.id));
    if (!league) throw httpError(404, 'league not found');
    if (leagueRole(db, league.id, user.id) !== 'admin') throw httpError(403, 'league admin required');
    const targetId = Number(req.params.userId);
    if (targetId === user.id) return reply.code(400).send({ error: 'use leave instead' });
    if (!setLeagueMemberStatus(db, league.id, targetId, 'removed')) {
      return reply.code(404).send({ error: 'member not found' });
    }
    return { ok: true };
  });

  // --- league invites (standing + one-time), mirroring group invites ---

  app.get<{ Params: { id: string } }>('/api/leagues/:id/invites', async (req) => {
    const user = requireUser(req);
    const league = getLeague(db, Number(req.params.id));
    if (!league) throw httpError(404, 'league not found');
    if (!leagueRole(db, league.id, user.id)) throw httpError(403, 'league member required');
    const standing = standingInvite(db, 'league', league.id);
    const isAdmin = leagueRole(db, league.id, user.id) === 'admin';
    const oneTime = isAdmin
      ? db
          .prepare(
            `SELECT code, expires_at AS expiresAt, max_uses AS maxUses, uses, revoked
             FROM invites WHERE scope = 'league' AND target_id = ? AND kind = 'one-time' ORDER BY created_at DESC`,
          )
          .all(league.id)
      : [];
    return { standing: standing ? { code: standing.code } : null, oneTime };
  });

  app.post<{ Params: { id: string }; Body: { ttlHours?: number; maxUses?: number } }>(
    '/api/leagues/:id/invites',
    async (req, reply) => {
      const user = requireUser(req);
      const league = getLeague(db, Number(req.params.id));
      if (!league) throw httpError(404, 'league not found');
      if (leagueRole(db, league.id, user.id) !== 'admin') throw httpError(403, 'league admin required');
      const ttlHours = req.body?.ttlHours ?? 24;
      const maxUses = req.body?.maxUses ?? 1;
      if (ttlHours < 1 || ttlHours > 720 || maxUses < 1 || maxUses > 100) {
        return reply.code(400).send({ error: 'ttlHours 1-720, maxUses 1-100' });
      }
      const invite = createInvite(db, 'league', league.id, 'one-time', user.id, { ttlHours, maxUses });
      return { invite: { code: invite.code, expiresAt: invite.expires_at, maxUses: invite.max_uses } };
    },
  );

  app.post<{ Params: { id: string } }>('/api/leagues/:id/invites/standing/regenerate', async (req) => {
    const user = requireUser(req);
    const league = getLeague(db, Number(req.params.id));
    if (!league) throw httpError(404, 'league not found');
    if (leagueRole(db, league.id, user.id) !== 'admin') throw httpError(403, 'league admin required');
    const invite = regenerateStandingInvite(db, 'league', league.id, user.id);
    return { standing: { code: invite.code } };
  });
}
