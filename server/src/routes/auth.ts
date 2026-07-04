import type { FastifyInstance } from 'fastify';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { SESSION_COOKIE, createSession, deleteSession } from '../auth/sessions.js';

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const PASSWORD_MIN = 8;

export function registerAuthRoutes(app: FastifyInstance): void {
  const { db, config } = app.ctx;
  const secure = config.appOrigin.startsWith('https://');

  const cookieOpts = {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    maxAge: config.sessionTtlDays * 86_400,
  };

  app.post<{ Body: { username?: string; password?: string; displayName?: string } }>(
    '/api/auth/register',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { username, password, displayName } = req.body ?? {};
      if (!username || !USERNAME_RE.test(username)) {
        return reply.code(400).send({ error: 'username must be 3-32 chars: letters, digits, _ . -' });
      }
      if (!password || password.length < PASSWORD_MIN) {
        return reply.code(400).send({ error: `password must be at least ${PASSWORD_MIN} characters` });
      }
      const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
      if (exists) return reply.code(409).send({ error: 'username is taken' });

      const passwordHash = await hashPassword(password);
      const isOperator = config.operatorUsername?.toLowerCase() === username.toLowerCase() ? 1 : 0;
      const info = db
        .prepare(
          'INSERT INTO users (username, password_hash, display_name, is_operator, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(username, passwordHash, displayName ?? null, isOperator, Date.now());

      const session = createSession(db, Number(info.lastInsertRowid), config.sessionTtlDays);
      reply.setCookie(SESSION_COOKIE, session.token, cookieOpts);
      return {
        user: { id: Number(info.lastInsertRowid), username, displayName: displayName ?? null },
        // Surfaced at signup per SPEC §6: no self-service recovery exists.
        recoveryNotice:
          'There is no password reset. Keep your credentials safe — consider adding a passkey.',
      };
    },
  );

  app.post<{ Body: { username?: string; password?: string } }>(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { username, password } = req.body ?? {};
      const row = db
        .prepare('SELECT id, password_hash, suspended FROM users WHERE username = ?')
        .get(username ?? '') as { id: number; password_hash: string; suspended: number } | undefined;
      if (!row || !password || !(await verifyPassword(password, row.password_hash))) {
        return reply.code(401).send({ error: 'invalid username or password' });
      }
      if (row.suspended) return reply.code(403).send({ error: 'account suspended' });

      const session = createSession(db, row.id, config.sessionTtlDays);
      reply.setCookie(SESSION_COOKIE, session.token, cookieOpts);
      return { ok: true };
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) deleteSession(db, token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'not signed in' });
    return { user: req.user };
  });
}
