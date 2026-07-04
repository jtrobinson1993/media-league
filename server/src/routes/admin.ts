import type { FastifyInstance } from 'fastify';
import { requireUser } from '../app.js';
import { httpError } from '../lib/permissions.js';
import { hashPassword } from '../auth/passwords.js';
import { deleteUserSessions, type SessionUser } from '../auth/sessions.js';

function requireOperator(req: { user: SessionUser | null }): SessionUser {
  const user = requireUser(req);
  if (!user.isOperator) throw httpError(403, 'operator required');
  return user;
}

/** Operator console API (SPEC §13): the instance super-admin's tools. */
export function registerAdminRoutes(app: FastifyInstance): void {
  const { db } = app.ctx;

  app.get('/api/admin/stats', async (req) => {
    requireOperator(req);
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    return {
      users: count('SELECT COUNT(*) AS n FROM users'),
      groups: count('SELECT COUNT(*) AS n FROM groups'),
      leagues: count('SELECT COUNT(*) AS n FROM leagues'),
      rounds: count('SELECT COUNT(*) AS n FROM rounds'),
      submissions: count('SELECT COUNT(*) AS n FROM submissions'),
    };
  });

  app.get<{ Querystring: { q?: string } }>('/api/admin/users', async (req) => {
    requireOperator(req);
    const q = `%${req.query.q ?? ''}%`;
    const users = db
      .prepare(
        `SELECT id, username, display_name AS displayName, suspended, is_operator AS isOperator, created_at AS createdAt
         FROM users WHERE username LIKE ? ORDER BY username LIMIT 100`,
      )
      .all(q);
    return { users };
  });

  app.post<{ Params: { id: string }; Body: { suspended?: boolean } }>(
    '/api/admin/users/:id/suspend',
    async (req, reply) => {
      const op = requireOperator(req);
      const id = Number(req.params.id);
      if (id === op.id) return reply.code(400).send({ error: 'cannot suspend yourself' });
      const suspended = req.body?.suspended !== false;
      const info = db.prepare('UPDATE users SET suspended = ? WHERE id = ?').run(suspended ? 1 : 0, id);
      if (info.changes === 0) return reply.code(404).send({ error: 'user not found' });
      if (suspended) deleteUserSessions(db, id); // ban blocks login (SPEC §13)
      return { ok: true };
    },
  );

  // Manual recovery (SPEC §6): operator-only, not a user-facing feature.
  app.post<{ Params: { id: string }; Body: { newPassword?: string } }>(
    '/api/admin/users/:id/reset-password',
    async (req, reply) => {
      requireOperator(req);
      const id = Number(req.params.id);
      const pw = req.body?.newPassword;
      if (!pw || pw.length < 8) return reply.code(400).send({ error: 'newPassword min 8 chars' });
      const info = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(pw), id);
      if (info.changes === 0) return reply.code(404).send({ error: 'user not found' });
      deleteUserSessions(db, id);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/clear-passkeys', async (req, reply) => {
    requireOperator(req);
    const id = Number(req.params.id);
    const exists = db.prepare('SELECT 1 FROM users WHERE id = ?').get(id);
    if (!exists) return reply.code(404).send({ error: 'user not found' });
    db.prepare('DELETE FROM credentials WHERE user_id = ?').run(id);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/groups/:id', async (req, reply) => {
    requireOperator(req);
    const info = db.prepare('DELETE FROM groups WHERE id = ?').run(Number(req.params.id));
    if (info.changes === 0) return reply.code(404).send({ error: 'group not found' });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/leagues/:id', async (req, reply) => {
    requireOperator(req);
    const info = db.prepare('DELETE FROM leagues WHERE id = ?').run(Number(req.params.id));
    if (info.changes === 0) return reply.code(404).send({ error: 'league not found' });
    return { ok: true };
  });
}
