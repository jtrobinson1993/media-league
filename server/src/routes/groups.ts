import type { FastifyInstance } from 'fastify';
import { requireUser } from '../app.js';
import { groupRole, requireGroupAdmin, requireGroupMember, httpError } from '../lib/permissions.js';
import {
  createInvite,
  standingInvite,
  regenerateStandingInvite,
  getInviteByCode,
  inviteValidity,
  consumeInvite,
} from '../lib/invites.js';
import { joinGroup, joinLeague, setGroupMemberStatus } from '../lib/memberships.js';

export function registerGroupRoutes(app: FastifyInstance): void {
  const { db } = app.ctx;

  app.post<{ Body: { name?: string } }>('/api/groups', async (req, reply) => {
    const user = requireUser(req);
    const name = req.body?.name?.trim();
    if (!name || name.length > 80) return reply.code(400).send({ error: 'name required (max 80 chars)' });

    const info = db
      .prepare('INSERT INTO groups (name, created_by, created_at) VALUES (?, ?, ?)')
      .run(name, user.id, Date.now());
    const groupId = Number(info.lastInsertRowid);
    joinGroup(db, groupId, user.id, 'admin');
    createInvite(db, 'group', groupId, 'standing', user.id);
    return { group: { id: groupId, name } };
  });

  app.get('/api/groups', async (req) => {
    const user = requireUser(req);
    const rows = db
      .prepare(
        `SELECT g.id, g.name, gm.role
         FROM groups g JOIN group_members gm ON gm.group_id = g.id
         WHERE gm.user_id = ? AND gm.status = 'active'
         ORDER BY g.name`,
      )
      .all(user.id);
    return { groups: rows };
  });

  app.get<{ Params: { id: string } }>('/api/groups/:id', async (req) => {
    const user = requireUser(req);
    const groupId = Number(req.params.id);
    requireGroupMember(db, groupId, user.id);

    const group = db.prepare('SELECT id, name, created_at FROM groups WHERE id = ?').get(groupId);
    if (!group) throw httpError(404, 'group not found');
    const members = db
      .prepare(
        `SELECT u.id, u.username, u.display_name AS displayName, gm.role
         FROM group_members gm JOIN users u ON u.id = gm.user_id
         WHERE gm.group_id = ? AND gm.status = 'active' ORDER BY u.username`,
      )
      .all(groupId);
    const leagues = db
      .prepare(
        // Public leagues are listed for every member; private ones only for
        // their own active members (SPEC §9).
        `SELECT l.id, l.name, l.media_type AS mediaType, l.visibility
         FROM leagues l WHERE l.group_id = ?
           AND (l.visibility = 'public' OR l.id IN
             (SELECT league_id FROM league_members WHERE user_id = ? AND status = 'active'))
         ORDER BY l.name`,
      )
      .all(groupId, user.id);
    return { group, members, leagues, myRole: groupRole(db, groupId, user.id) };
  });

  app.patch<{ Params: { id: string }; Body: { name?: string } }>('/api/groups/:id', async (req, reply) => {
    const user = requireUser(req);
    const groupId = Number(req.params.id);
    requireGroupAdmin(db, groupId, user.id);
    const name = req.body?.name?.trim();
    if (!name || name.length > 80) return reply.code(400).send({ error: 'name required (max 80 chars)' });
    db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(name, groupId);
    return { ok: true };
  });

  // Promote/demote co-admins (SPEC §13).
  app.post<{ Params: { id: string; userId: string }; Body: { role?: 'admin' | 'member' } }>(
    '/api/groups/:id/members/:userId/role',
    async (req, reply) => {
      const user = requireUser(req);
      const groupId = Number(req.params.id);
      const targetId = Number(req.params.userId);
      requireGroupAdmin(db, groupId, user.id);
      const role = req.body?.role;
      if (role !== 'admin' && role !== 'member') return reply.code(400).send({ error: 'role must be admin|member' });
      if (targetId === user.id && role === 'member') {
        const admins = db
          .prepare("SELECT COUNT(*) AS n FROM group_members WHERE group_id = ? AND role = 'admin' AND status = 'active'")
          .get(groupId) as { n: number };
        if (admins.n === 1) return reply.code(400).send({ error: 'cannot demote the last admin' });
      }
      const info = db
        .prepare("UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ? AND status = 'active'")
        .run(role, groupId, targetId);
      if (info.changes === 0) return reply.code(404).send({ error: 'member not found' });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>('/api/groups/:id/members/:userId', async (req, reply) => {
    const user = requireUser(req);
    const groupId = Number(req.params.id);
    const targetId = Number(req.params.userId);
    requireGroupAdmin(db, groupId, user.id);
    if (targetId === user.id) return reply.code(400).send({ error: 'use leave instead' });
    if (!setGroupMemberStatus(db, groupId, targetId, 'removed')) {
      return reply.code(404).send({ error: 'member not found' });
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/groups/:id/leave', async (req, reply) => {
    const user = requireUser(req);
    const groupId = Number(req.params.id);
    const admins = db
      .prepare("SELECT COUNT(*) AS n FROM group_members WHERE group_id = ? AND role = 'admin' AND status = 'active'")
      .get(groupId) as { n: number };
    const myRole = groupRole(db, groupId, user.id);
    if (myRole === 'admin' && admins.n === 1) {
      return reply.code(400).send({ error: 'promote another admin before leaving' });
    }
    if (!setGroupMemberStatus(db, groupId, user.id, 'left')) return reply.code(404).send({ error: 'not a member' });
    return { ok: true };
  });

  // --- invites ---

  app.get<{ Params: { id: string } }>('/api/groups/:id/invites', async (req) => {
    const user = requireUser(req);
    const groupId = Number(req.params.id);
    requireGroupMember(db, groupId, user.id);
    // Standing link is shareable by any member (SPEC §16).
    const standing = standingInvite(db, 'group', groupId);
    const isAdmin = groupRole(db, groupId, user.id) === 'admin';
    const oneTime = isAdmin
      ? db
          .prepare(
            `SELECT code, expires_at AS expiresAt, max_uses AS maxUses, uses, revoked
             FROM invites WHERE scope = 'group' AND target_id = ? AND kind = 'one-time' ORDER BY created_at DESC`,
          )
          .all(groupId)
      : [];
    return { standing: standing ? { code: standing.code } : null, oneTime };
  });

  app.post<{ Params: { id: string }; Body: { ttlHours?: number; maxUses?: number } }>(
    '/api/groups/:id/invites',
    async (req, reply) => {
      const user = requireUser(req);
      const groupId = Number(req.params.id);
      requireGroupAdmin(db, groupId, user.id);
      const ttlHours = req.body?.ttlHours ?? 24;
      const maxUses = req.body?.maxUses ?? 1;
      if (ttlHours < 1 || ttlHours > 720 || maxUses < 1 || maxUses > 100) {
        return reply.code(400).send({ error: 'ttlHours 1-720, maxUses 1-100' });
      }
      const invite = createInvite(db, 'group', groupId, 'one-time', user.id, { ttlHours, maxUses });
      return { invite: { code: invite.code, expiresAt: invite.expires_at, maxUses: invite.max_uses } };
    },
  );

  app.post<{ Params: { id: string } }>('/api/groups/:id/invites/standing/regenerate', async (req) => {
    const user = requireUser(req);
    const groupId = Number(req.params.id);
    requireGroupAdmin(db, groupId, user.id);
    const invite = regenerateStandingInvite(db, 'group', groupId, user.id);
    return { standing: { code: invite.code } };
  });

  // --- invite preview + accept (both scopes) ---

  app.get<{ Params: { code: string } }>('/api/invites/:code', async (req, reply) => {
    const invite = getInviteByCode(db, req.params.code);
    const validity = inviteValidity(invite);
    if (validity !== 'ok') return reply.code(404).send({ error: `invite ${validity}` });
    if (invite!.scope === 'group') {
      const group = db.prepare('SELECT name FROM groups WHERE id = ?').get(invite!.target_id) as
        | { name: string }
        | undefined;
      return { scope: 'group', name: group?.name };
    }
    const league = db
      .prepare('SELECT l.name, l.group_id AS groupId, g.name AS groupName FROM leagues l JOIN groups g ON g.id = l.group_id WHERE l.id = ?')
      .get(invite!.target_id) as { name: string; groupId: number; groupName: string } | undefined;
    return { scope: 'league', name: league?.name, groupName: league?.groupName };
  });

  app.post<{ Params: { code: string } }>('/api/invites/:code/accept', async (req, reply) => {
    const user = requireUser(req);
    const invite = getInviteByCode(db, req.params.code);
    const validity = inviteValidity(invite);
    if (validity !== 'ok') return reply.code(404).send({ error: `invite ${validity}` });

    const accept = db.transaction(() => {
      if (invite!.scope === 'group') {
        joinGroup(db, invite!.target_id, user.id);
        consumeInvite(db, invite!);
        return { joined: { groupId: invite!.target_id } };
      }
      // League invite joins the group AND the league in one step (SPEC §9).
      const league = db.prepare('SELECT group_id FROM leagues WHERE id = ?').get(invite!.target_id) as
        | { group_id: number }
        | undefined;
      if (!league) throw httpError(404, 'league not found');
      joinGroup(db, league.group_id, user.id);
      joinLeague(db, invite!.target_id, user.id);
      consumeInvite(db, invite!);
      return { joined: { groupId: league.group_id, leagueId: invite!.target_id } };
    });
    try {
      return accept();
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });
}
