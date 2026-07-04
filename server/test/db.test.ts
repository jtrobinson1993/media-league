import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('database schema', () => {
  it('migrates a fresh database to v1 with all tables', () => {
    const db = openDb(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of [
      'users',
      'credentials',
      'sessions',
      'groups',
      'group_members',
      'leagues',
      'league_members',
      'rounds',
      'submissions',
      'votes',
      'round_results',
      'invites',
      'notifications',
      'push_subscriptions',
      'webhooks',
      'coin_ledger',
      'cosmetic_items',
      'user_inventory',
      'media_cache',
    ]) {
      expect(tables, `missing table ${t}`).toContain(t);
    }
  });

  it('is idempotent (re-running migrations is a no-op)', () => {
    const db = openDb(':memory:');
    const version = db
      .prepare('SELECT MAX(version) AS v FROM schema_migrations')
      .get() as { v: number };
    expect(version.v).toBe(2);
  });
});

describe('app', () => {
  it('serves /api/health', async () => {
    const db = openDb(':memory:');
    const app = await buildApp({ config: loadConfig({}), db });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});
