import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp({ config: loadConfig({ OPERATOR_USERNAME: 'oper' }), db: openDb(':memory:') });
});

function cookieOf(res: { cookies: { name: string; value: string }[] }): string {
  const c = res.cookies.find((c) => c.name === 'ml_session');
  expect(c).toBeDefined();
  return `ml_session=${c!.value}`;
}

describe('auth', () => {
  it('registers, sets a session cookie, and reports no-recovery notice', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'password1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().recoveryNotice).toMatch(/no password reset/i);

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookieOf(res) } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe('alice');
  });

  it('rejects invalid usernames and short passwords', async () => {
    for (const payload of [
      { username: 'a', password: 'password1' },
      { username: 'has spaces', password: 'password1' },
      { username: 'alice', password: 'short' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it('rejects duplicate usernames (case-insensitive)', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'alice', password: 'password1' } });
    const dup = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'ALICE', password: 'password2' } });
    expect(dup.statusCode).toBe(409);
  });

  it('logs in with correct credentials, rejects wrong ones', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'alice', password: 'password1' } });

    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'wrong' } });
    expect(bad.statusCode).toBe(401);

    const good = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'password1' } });
    expect(good.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookieOf(good) } });
    expect(me.json().user.username).toBe('alice');
  });

  it('logout invalidates the session', async () => {
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'alice', password: 'password1' } });
    const cookie = cookieOf(reg);
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });

  it('grants operator to the configured username', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'oper', password: 'password1' } });
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookieOf(res) } });
    expect(me.json().user.isOperator).toBe(true);
  });
});
