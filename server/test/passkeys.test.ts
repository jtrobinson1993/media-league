import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp({ config: loadConfig({}), db: openDb(':memory:') });
});

async function registerAlice(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'alice', password: 'password1' },
  });
  const c = res.cookies.find((c) => c.name === 'ml_session')!;
  return `ml_session=${c.value}`;
}

describe('passkeys', () => {
  it('requires auth for registration options', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/passkeys/register-options' });
    expect(res.statusCode).toBe(401);
  });

  it('issues registration options with the RP from APP_ORIGIN', async () => {
    const cookie = await registerAlice();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/passkeys/register-options',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rp.id).toBe('localhost');
    expect(body.challenge).toBeTruthy();
    expect(body.user.name).toBe('alice');
  });

  it('rejects register-verify without pending challenge and with garbage response', async () => {
    const cookie = await registerAlice();
    const noPending = await app.inject({
      method: 'POST',
      url: '/api/auth/passkeys/register-verify',
      headers: { cookie },
      payload: { id: 'zzz' },
    });
    expect(noPending.statusCode).toBe(400);

    await app.inject({ method: 'POST', url: '/api/auth/passkeys/register-options', headers: { cookie } });
    const garbage = await app.inject({
      method: 'POST',
      url: '/api/auth/passkeys/register-verify',
      headers: { cookie },
      payload: { id: 'zzz', rawId: 'zzz', type: 'public-key', response: {} },
    });
    expect(garbage.statusCode).toBe(400);
  });

  it('issues login options without revealing whether a username exists', async () => {
    const known = await app.inject({
      method: 'POST',
      url: '/api/auth/passkeys/login-options',
      payload: { username: 'alice' },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/auth/passkeys/login-options',
      payload: { username: 'ghost' },
    });
    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    expect(known.json().challenge).toBeTruthy();
  });

  it('rejects login-verify with unknown credential', async () => {
    const opts = await app.inject({ method: 'POST', url: '/api/auth/passkeys/login-options', payload: {} });
    const key = opts.headers['x-challenge-key'] as string;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/passkeys/login-verify',
      payload: { challengeKey: key, response: { id: 'nope' } },
    });
    expect(res.statusCode).toBe(401);
  });

  it('lists and deletes passkeys (empty set)', async () => {
    const cookie = await registerAlice();
    const list = await app.inject({ method: 'GET', url: '/api/auth/passkeys', headers: { cookie } });
    expect(list.json().passkeys).toEqual([]);
    const del = await app.inject({ method: 'DELETE', url: '/api/auth/passkeys/xyz', headers: { cookie } });
    expect(del.statusCode).toBe(404);
  });
});
