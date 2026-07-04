import type { FastifyInstance } from 'fastify';
import type { WebhookEvent, WebhookFormat } from '@media-league/shared';
import { requireUser } from '../app.js';
import { leagueRole, httpError } from '../lib/permissions.js';
import { getLeague } from './leagues.js';

const ALL_EVENTS: WebhookEvent[] = [
  'round.created',
  'submissions.open',
  'submissions.closed',
  'voting.open',
  'voting.closed',
  'results.posted',
  'winner.announced',
];

export function registerNotificationRoutes(app: FastifyInstance): void {
  const { db, config } = app.ctx;

  // --- in-app notification center (SPEC §14) ---

  app.get<{ Querystring: { limit?: string } }>('/api/notifications', async (req) => {
    const user = requireUser(req);
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const rows = db
      .prepare(
        'SELECT id, type, payload, read, created_at AS createdAt FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?',
      )
      .all(user.id, limit) as { id: number; type: string; payload: string; read: number; createdAt: number }[];
    const unread = (db
      .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0')
      .get(user.id) as { n: number }).n;
    return {
      unread,
      notifications: rows.map((r) => ({ ...r, payload: JSON.parse(r.payload), read: r.read === 1 })),
    };
  });

  app.post<{ Body: { ids?: number[]; all?: boolean } }>('/api/notifications/read', async (req, reply) => {
    const user = requireUser(req);
    const b = req.body ?? {};
    if (b.all) {
      db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(user.id);
      return { ok: true };
    }
    if (!Array.isArray(b.ids) || b.ids.length === 0) return reply.code(400).send({ error: 'ids[] or all required' });
    const marks = db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND id = ?');
    const txn = db.transaction(() => {
      for (const id of b.ids!) marks.run(user.id, Number(id));
    });
    txn();
    return { ok: true };
  });

  // --- web push (SPEC §14) ---

  app.get('/api/push/vapid-key', async (_req, reply) => {
    if (!config.vapidPublicKey) return reply.code(404).send({ error: 'push not configured' });
    return { key: config.vapidPublicKey };
  });

  app.post<{ Body: { endpoint?: string; keys?: { p256dh?: string; auth?: string } } }>(
    '/api/push/subscribe',
    async (req, reply) => {
      const user = requireUser(req);
      const { endpoint, keys } = req.body ?? {};
      if (!endpoint || !keys?.p256dh || !keys?.auth) return reply.code(400).send({ error: 'bad subscription' });
      db.prepare(
        `INSERT INTO push_subscriptions (user_id, endpoint, keys, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, endpoint) DO UPDATE SET keys = excluded.keys`,
      ).run(user.id, endpoint, JSON.stringify(keys), Date.now());
      return { ok: true };
    },
  );

  app.post<{ Body: { endpoint?: string } }>('/api/push/unsubscribe', async (req, reply) => {
    const user = requireUser(req);
    if (!req.body?.endpoint) return reply.code(400).send({ error: 'endpoint required' });
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(user.id, req.body.endpoint);
    return { ok: true };
  });

  // --- league webhooks (SPEC §14, league-admin configured) ---

  function requireLeagueAdmin(leagueId: number, userId: number): void {
    if (leagueRole(db, leagueId, userId) !== 'admin') throw httpError(403, 'league admin required');
  }

  app.get<{ Params: { id: string } }>('/api/leagues/:id/webhooks', async (req) => {
    const user = requireUser(req);
    const league = getLeague(db, Number(req.params.id));
    if (!league) throw httpError(404, 'league not found');
    requireLeagueAdmin(league.id, user.id);
    const hooks = db
      .prepare('SELECT id, url, format, events, created_at AS createdAt FROM webhooks WHERE league_id = ?')
      .all(league.id) as { id: number; url: string; format: string; events: string; createdAt: number }[];
    return { webhooks: hooks.map((h) => ({ ...h, events: JSON.parse(h.events) })) };
  });

  app.post<{ Params: { id: string }; Body: { url?: string; format?: WebhookFormat; events?: WebhookEvent[] } }>(
    '/api/leagues/:id/webhooks',
    async (req, reply) => {
      const user = requireUser(req);
      const league = getLeague(db, Number(req.params.id));
      if (!league) throw httpError(404, 'league not found');
      requireLeagueAdmin(league.id, user.id);

      const { url, format } = req.body ?? {};
      if (!url || !/^https?:\/\//.test(url) || url.length > 500) return reply.code(400).send({ error: 'valid url required' });
      if (format !== 'generic' && format !== 'discord' && format !== 'slack') {
        return reply.code(400).send({ error: 'format must be generic|discord|slack' });
      }
      const events = req.body?.events ?? ALL_EVENTS;
      if (!Array.isArray(events) || events.length === 0 || !events.every((e) => ALL_EVENTS.includes(e))) {
        return reply.code(400).send({ error: 'bad events list' });
      }
      const info = db
        .prepare('INSERT INTO webhooks (league_id, url, format, events, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(league.id, url, format, JSON.stringify(events), user.id, Date.now());
      return { webhook: { id: Number(info.lastInsertRowid), url, format, events } };
    },
  );

  app.delete<{ Params: { id: string; hookId: string } }>('/api/leagues/:id/webhooks/:hookId', async (req, reply) => {
    const user = requireUser(req);
    const league = getLeague(db, Number(req.params.id));
    if (!league) throw httpError(404, 'league not found');
    requireLeagueAdmin(league.id, user.id);
    const info = db.prepare('DELETE FROM webhooks WHERE id = ? AND league_id = ?').run(Number(req.params.hookId), league.id);
    if (info.changes === 0) return reply.code(404).send({ error: 'webhook not found' });
    return { ok: true };
  });
}
