import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let app: FastifyInstance;
let db: DB;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildApp({ config: loadConfig({ OPERATOR_USERNAME: 'oper' }), db, media: {} });
});

async function signup(username: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password: 'password1' } });
  return `ml_session=${res.cookies.find((c) => c.name === 'ml_session')!.value}`;
}

function giveCoins(username: string, coins: number): void {
  db.prepare('UPDATE users SET coins = ? WHERE username = ?').run(coins, username);
}

describe('store', () => {
  it('lists the seeded frame catalog with wallet and ownership', async () => {
    const alice = await signup('alice');
    const res = await app.inject({ method: 'GET', url: '/api/store', headers: { cookie: alice } });
    const body = res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(8);
    expect(body.items.every((i: { type: string }) => i.type === 'frame')).toBe(true);
    expect(body.owned).toEqual([]);
    expect(body.coins).toBe(0);
  });

  it('buy checks funds, deducts, auto-equips, and prevents rebuy', async () => {
    const alice = await signup('alice');
    const poor = await app.inject({ method: 'POST', url: '/api/store/buy', headers: { cookie: alice }, payload: { itemId: 'frame.popcorn' } });
    expect(poor.statusCode).toBe(400); // 0 coins

    giveCoins('alice', 100);
    const buy = await app.inject({ method: 'POST', url: '/api/store/buy', headers: { cookie: alice }, payload: { itemId: 'frame.popcorn' } });
    expect(buy.statusCode).toBe(200);
    expect(buy.json().coins).toBe(60); // 100 - 40
    expect(buy.json().equipped.frame).toBe('frame.popcorn'); // auto-equip

    const again = await app.inject({ method: 'POST', url: '/api/store/buy', headers: { cookie: alice }, payload: { itemId: 'frame.popcorn' } });
    expect(again.statusCode).toBe(409);

    // spend recorded in ledger
    const ledger = db.prepare("SELECT amount FROM coin_ledger WHERE reason = 'purchase:frame.popcorn'").get() as { amount: number };
    expect(ledger.amount).toBe(-40);
  });

  it('equip requires ownership; unequip works', async () => {
    const alice = await signup('alice');
    const notOwned = await app.inject({ method: 'POST', url: '/api/store/equip', headers: { cookie: alice }, payload: { type: 'frame', itemId: 'frame.cult-vhs' } });
    expect(notOwned.statusCode).toBe(403);

    giveCoins('alice', 90);
    await app.inject({ method: 'POST', url: '/api/store/buy', headers: { cookie: alice }, payload: { itemId: 'frame.cult-vhs' } });
    const unequip = await app.inject({ method: 'POST', url: '/api/store/equip', headers: { cookie: alice }, payload: { type: 'frame', itemId: null } });
    expect(unequip.json().equipped.frame).toBeUndefined();
  });
});

describe('profile', () => {
  it('updates displayName and avatar with validation', async () => {
    const alice = await signup('alice');
    const bad = await app.inject({ method: 'PATCH', url: '/api/me/profile', headers: { cookie: alice }, payload: { avatar: { kind: 'gallery', id: 'not-real', color: 'auto' } } });
    expect(bad.statusCode).toBe(400);

    const good = await app.inject({
      method: 'PATCH', url: '/api/me/profile', headers: { cookie: alice },
      payload: { displayName: 'Alice A.', avatar: { kind: 'gallery', id: 'robot', color: '#aa22ff' } },
    });
    expect(good.statusCode).toBe(200);

    const me = await app.inject({ method: 'GET', url: '/api/me/profile', headers: { cookie: alice } });
    expect(me.json().displayName).toBe('Alice A.');
    expect(me.json().avatar).toEqual({ kind: 'gallery', id: 'robot', color: '#aa22ff' });
  });

  it('public profile returns stats for another user', async () => {
    const alice = await signup('alice');
    await signup('bob');
    const res = await app.inject({ method: 'GET', url: '/api/users/2/profile', headers: { cookie: alice } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.username).toBe('bob');
    expect(res.json().stats).toMatchObject({ roundsPlayed: 0, totalPoints: 0, wins: 0, avgPoints: 0 });
  });
});

describe('operator console', () => {
  it('rejects non-operators', async () => {
    const alice = await signup('alice');
    for (const url of ['/api/admin/stats', '/api/admin/users']) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: alice } });
      expect(res.statusCode).toBe(403);
    }
  });

  it('suspend blocks login and kills sessions; unsuspend restores', async () => {
    const oper = await signup('oper');
    const alice = await signup('alice');

    await app.inject({ method: 'POST', url: '/api/admin/users/2/suspend', headers: { cookie: oper }, payload: {} });
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: alice } });
    expect(me.statusCode).toBe(401); // session killed
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'password1' } });
    expect(login.statusCode).toBe(403); // suspended

    await app.inject({ method: 'POST', url: '/api/admin/users/2/suspend', headers: { cookie: oper }, payload: { suspended: false } });
    const relogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'password1' } });
    expect(relogin.statusCode).toBe(200);
  });

  it('manual password reset works and invalidates old password', async () => {
    const oper = await signup('oper');
    await signup('alice');
    const reset = await app.inject({
      method: 'POST', url: '/api/admin/users/2/reset-password', headers: { cookie: oper },
      payload: { newPassword: 'freshpass9' },
    });
    expect(reset.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'password1' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'freshpass9' } })).statusCode).toBe(200);
  });

  it('operator cannot suspend themselves; stats count entities', async () => {
    const oper = await signup('oper');
    const self = await app.inject({ method: 'POST', url: '/api/admin/users/1/suspend', headers: { cookie: oper }, payload: {} });
    expect(self.statusCode).toBe(400);

    await app.inject({ method: 'POST', url: '/api/groups', headers: { cookie: oper }, payload: { name: 'G' } });
    const stats = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { cookie: oper } });
    expect(stats.json()).toMatchObject({ users: 1, groups: 1 });
  });
});
