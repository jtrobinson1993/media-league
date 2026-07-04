import type { FastifyInstance } from 'fastify';
import { requireUser } from '../app.js';
import { httpError } from '../lib/permissions.js';

const GALLERY_IDS = new Set([
  'slasher-mask', 'robot', 'alien', 'film-reel', 'vampire', 'ghost', 'clown', 'popcorn',
  'zombie', 'detective', 'astronaut', 'dinosaur',
]);
const COLOR_RE = /^(auto|#[0-9a-fA-F]{6})$/;

function parseAvatar(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const a = input as Record<string, unknown>;
  if (typeof a.color !== 'string' || !COLOR_RE.test(a.color)) return null;
  if (a.kind === 'initials') return JSON.stringify({ kind: 'initials', color: a.color });
  if (a.kind === 'gallery' && typeof a.id === 'string' && GALLERY_IDS.has(a.id)) {
    return JSON.stringify({ kind: 'gallery', id: a.id, color: a.color });
  }
  return null;
}

export function registerProfileRoutes(app: FastifyInstance): void {
  const { db } = app.ctx;

  app.get('/api/me/profile', async (req) => {
    const user = requireUser(req);
    const row = db
      .prepare('SELECT username, display_name AS displayName, avatar, coins, equipped FROM users WHERE id = ?')
      .get(user.id) as { username: string; displayName: string | null; avatar: string; coins: number; equipped: string };
    return {
      id: user.id,
      username: row.username,
      displayName: row.displayName,
      avatar: JSON.parse(row.avatar),
      coins: row.coins,
      equipped: JSON.parse(row.equipped),
      isOperator: user.isOperator,
    };
  });

  app.patch<{ Body: { displayName?: string | null; avatar?: unknown } }>('/api/me/profile', async (req, reply) => {
    const user = requireUser(req);
    const b = req.body ?? {};
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (b.displayName !== undefined) {
      if (b.displayName !== null && (typeof b.displayName !== 'string' || b.displayName.length > 50)) {
        return reply.code(400).send({ error: 'displayName max 50 chars' });
      }
      sets.push('display_name = ?');
      vals.push(b.displayName?.trim() || null);
    }
    if (b.avatar !== undefined) {
      const avatar = parseAvatar(b.avatar);
      if (!avatar) return reply.code(400).send({ error: 'bad avatar config' });
      sets.push('avatar = ?');
      vals.push(avatar);
    }
    if (sets.length === 0) return reply.code(400).send({ error: 'nothing to update' });
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, user.id);
    return { ok: true };
  });

  // Public profile + cross-league stats (SPEC §15).
  app.get<{ Params: { id: string } }>('/api/users/:id/profile', async (req) => {
    requireUser(req);
    const id = Number(req.params.id);
    const row = db
      .prepare('SELECT id, username, display_name AS displayName, avatar, equipped, created_at AS createdAt FROM users WHERE id = ?')
      .get(id) as { id: number; username: string; displayName: string | null; avatar: string; equipped: string; createdAt: number } | undefined;
    if (!row) throw httpError(404, 'user not found');

    const stats = db
      .prepare(
        `SELECT COUNT(DISTINCT s.round_id) AS roundsPlayed,
                COALESCE(SUM(rr.score), 0) AS totalPoints,
                COUNT(DISTINCT CASE WHEN rr.placement = 1 THEN rr.round_id END) AS wins
         FROM submissions s LEFT JOIN round_results rr ON rr.submission_id = s.id
         WHERE s.user_id = ?`,
      )
      .get(id) as { roundsPlayed: number; totalPoints: number; wins: number };

    const recent = db
      .prepare(
        `SELECT s.title, s.year, s.image_url AS imageUrl, rr.score, rr.placement, r.prompt_title AS prompt
         FROM submissions s
         JOIN rounds r ON r.id = s.round_id AND r.phase = 'finished'
         LEFT JOIN round_results rr ON rr.submission_id = s.id
         WHERE s.user_id = ? ORDER BY r.finalized_at DESC LIMIT 20`,
      )
      .all(id);

    return {
      user: { ...row, avatar: JSON.parse(row.avatar), equipped: JSON.parse(row.equipped) },
      stats: {
        ...stats,
        avgPoints: stats.roundsPlayed ? Math.round((stats.totalPoints / stats.roundsPlayed) * 10) / 10 : 0,
      },
      recentSubmissions: recent,
    };
  });

  // --- store (SPEC §16: one try-on grid; buying auto-equips) ---

  app.get('/api/store', async (req) => {
    const user = requireUser(req);
    const items = db.prepare('SELECT id, type, name, price, asset FROM cosmetic_items ORDER BY price').all();
    const owned = (db.prepare('SELECT item_id FROM user_inventory WHERE user_id = ?').all(user.id) as { item_id: string }[]).map((r) => r.item_id);
    const row = db.prepare('SELECT coins, equipped FROM users WHERE id = ?').get(user.id) as { coins: number; equipped: string };
    return { items, owned, coins: row.coins, equipped: JSON.parse(row.equipped) };
  });

  app.post<{ Body: { itemId?: string } }>('/api/store/buy', async (req, reply) => {
    const user = requireUser(req);
    const item = db.prepare('SELECT id, type, price FROM cosmetic_items WHERE id = ?').get(req.body?.itemId ?? '') as
      | { id: string; type: string; price: number }
      | undefined;
    if (!item) return reply.code(404).send({ error: 'item not found' });

    const buy = db.transaction(() => {
      const owned = db.prepare('SELECT 1 FROM user_inventory WHERE user_id = ? AND item_id = ?').get(user.id, item.id);
      if (owned) throw httpError(409, 'already owned');
      const { coins, equipped } = db.prepare('SELECT coins, equipped FROM users WHERE id = ?').get(user.id) as {
        coins: number;
        equipped: string;
      };
      if (coins < item.price) throw httpError(400, 'not enough coins');
      db.prepare('INSERT INTO user_inventory (user_id, item_id, acquired_at) VALUES (?, ?, ?)').run(user.id, item.id, Date.now());
      const newEquipped = { ...JSON.parse(equipped), [item.type]: item.id }; // buying auto-equips
      db.prepare('UPDATE users SET coins = coins - ?, equipped = ? WHERE id = ?').run(item.price, JSON.stringify(newEquipped), user.id);
      db.prepare('INSERT INTO coin_ledger (user_id, round_id, amount, reason, created_at) VALUES (?, NULL, ?, ?, ?)').run(
        user.id,
        -item.price,
        `purchase:${item.id}`,
        Date.now(),
      );
    });
    try {
      buy();
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
    const row = db.prepare('SELECT coins, equipped FROM users WHERE id = ?').get(user.id) as { coins: number; equipped: string };
    return { ok: true, coins: row.coins, equipped: JSON.parse(row.equipped) };
  });

  app.post<{ Body: { type?: string; itemId?: string | null } }>('/api/store/equip', async (req, reply) => {
    const user = requireUser(req);
    const type = req.body?.type;
    const itemId = req.body?.itemId ?? null;
    if (type !== 'frame') return reply.code(400).send({ error: 'unknown cosmetic type' });
    if (itemId !== null) {
      const owned = db
        .prepare(
          `SELECT 1 FROM user_inventory ui JOIN cosmetic_items ci ON ci.id = ui.item_id
           WHERE ui.user_id = ? AND ui.item_id = ? AND ci.type = ?`,
        )
        .get(user.id, itemId, type);
      if (!owned) return reply.code(403).send({ error: 'not owned' });
    }
    const { equipped } = db.prepare('SELECT equipped FROM users WHERE id = ?').get(user.id) as { equipped: string };
    const next = { ...JSON.parse(equipped) } as Record<string, string>;
    if (itemId === null) delete next[type];
    else next[type] = itemId;
    db.prepare('UPDATE users SET equipped = ? WHERE id = ?').run(JSON.stringify(next), user.id);
    return { ok: true, equipped: next };
  });
}
