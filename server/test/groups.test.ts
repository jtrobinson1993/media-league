import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp({ config: loadConfig({}), db: openDb(':memory:') });
});

async function signup(username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: 'password1' },
  });
  const c = res.cookies.find((c) => c.name === 'ml_session')!;
  return `ml_session=${c.value}`;
}

async function createGroup(cookie: string, name = 'Film Club'): Promise<number> {
  const res = await app.inject({ method: 'POST', url: '/api/groups', headers: { cookie }, payload: { name } });
  return res.json().group.id;
}

async function standingCode(cookie: string, groupId: number): Promise<string> {
  const res = await app.inject({ method: 'GET', url: `/api/groups/${groupId}/invites`, headers: { cookie } });
  return res.json().standing.code;
}

describe('groups', () => {
  it('creator becomes admin and gets a standing invite', async () => {
    const alice = await signup('alice');
    const id = await createGroup(alice);
    const detail = await app.inject({ method: 'GET', url: `/api/groups/${id}`, headers: { cookie: alice } });
    expect(detail.json().myRole).toBe('admin');
    expect(await standingCode(alice, id)).toBeTruthy();
  });

  it('standing invite joins a new user as member', async () => {
    const alice = await signup('alice');
    const id = await createGroup(alice);
    const code = await standingCode(alice, id);

    const bob = await signup('bob');
    const preview = await app.inject({ method: 'GET', url: `/api/invites/${code}` });
    expect(preview.json().name).toBe('Film Club');

    const accept = await app.inject({ method: 'POST', url: `/api/invites/${code}/accept`, headers: { cookie: bob } });
    expect(accept.statusCode).toBe(200);
    const detail = await app.inject({ method: 'GET', url: `/api/groups/${id}`, headers: { cookie: bob } });
    expect(detail.json().myRole).toBe('member');
  });

  it('regenerating the standing invite invalidates the old code', async () => {
    const alice = await signup('alice');
    const id = await createGroup(alice);
    const old = await standingCode(alice, id);
    await app.inject({ method: 'POST', url: `/api/groups/${id}/invites/standing/regenerate`, headers: { cookie: alice } });

    const bob = await signup('bob');
    const res = await app.inject({ method: 'POST', url: `/api/invites/${old}/accept`, headers: { cookie: bob } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/revoked/);
  });

  it('one-time invites exhaust after max uses', async () => {
    const alice = await signup('alice');
    const id = await createGroup(alice);
    const inv = await app.inject({
      method: 'POST',
      url: `/api/groups/${id}/invites`,
      headers: { cookie: alice },
      payload: { ttlHours: 24, maxUses: 1 },
    });
    const code = inv.json().invite.code;

    const bob = await signup('bob');
    const ok = await app.inject({ method: 'POST', url: `/api/invites/${code}/accept`, headers: { cookie: bob } });
    expect(ok.statusCode).toBe(200);

    const cara = await signup('cara');
    const fail = await app.inject({ method: 'POST', url: `/api/invites/${code}/accept`, headers: { cookie: cara } });
    expect(fail.statusCode).toBe(404);
    expect(fail.json().error).toMatch(/exhausted/);
  });

  it('co-admin promote/demote, last-admin guard', async () => {
    const alice = await signup('alice');
    const id = await createGroup(alice);
    const code = await standingCode(alice, id);
    const bob = await signup('bob');
    await app.inject({ method: 'POST', url: `/api/invites/${code}/accept`, headers: { cookie: bob } });

    // bob (member) can't promote
    const forbidden = await app.inject({
      method: 'POST',
      url: `/api/groups/${id}/members/2/role`,
      headers: { cookie: bob },
      payload: { role: 'admin' },
    });
    expect(forbidden.statusCode).toBe(403);

    // alice can't demote herself as last admin
    const lastAdmin = await app.inject({
      method: 'POST',
      url: `/api/groups/${id}/members/1/role`,
      headers: { cookie: alice },
      payload: { role: 'member' },
    });
    expect(lastAdmin.statusCode).toBe(400);

    // promote bob, then alice can demote herself
    await app.inject({
      method: 'POST',
      url: `/api/groups/${id}/members/2/role`,
      headers: { cookie: alice },
      payload: { role: 'admin' },
    });
    const demote = await app.inject({
      method: 'POST',
      url: `/api/groups/${id}/members/1/role`,
      headers: { cookie: alice },
      payload: { role: 'member' },
    });
    expect(demote.statusCode).toBe(200);
  });

  it('removal is history-preserving and blocks access', async () => {
    const alice = await signup('alice');
    const id = await createGroup(alice);
    const code = await standingCode(alice, id);
    const bob = await signup('bob');
    await app.inject({ method: 'POST', url: `/api/invites/${code}/accept`, headers: { cookie: bob } });

    await app.inject({ method: 'DELETE', url: `/api/groups/${id}/members/2`, headers: { cookie: alice } });
    const detail = await app.inject({ method: 'GET', url: `/api/groups/${id}`, headers: { cookie: bob } });
    expect(detail.statusCode).toBe(403);
  });

  it('last admin cannot leave without promoting someone', async () => {
    const alice = await signup('alice');
    const id = await createGroup(alice);
    const res = await app.inject({ method: 'POST', url: `/api/groups/${id}/leave`, headers: { cookie: alice } });
    expect(res.statusCode).toBe(400);
  });
});
