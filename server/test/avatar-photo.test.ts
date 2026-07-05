import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let app: FastifyInstance;

beforeEach(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ml-avatars-'));
  app = await buildApp({ config: loadConfig({ DATA_DIR: dataDir }), db: openDb(':memory:'), media: {} });
});

async function signup(username: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password: 'password1' } });
  return `ml_session=${res.cookies.find((c) => c.name === 'ml_session')!.value}`;
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // png magic-ish bytes

describe('avatar photos', () => {
  it('uploads a photo, switches avatar kind, and serves it back', async () => {
    const alice = await signup('alice');
    const up = await app.inject({
      method: 'PUT',
      url: '/api/me/avatar-photo',
      headers: { cookie: alice, 'content-type': 'image/png' },
      payload: PNG,
    });
    expect(up.statusCode).toBe(200);

    const me = await app.inject({ method: 'GET', url: '/api/me/profile', headers: { cookie: alice } });
    expect(me.json().avatar).toEqual({ kind: 'photo' });

    const img = await app.inject({ method: 'GET', url: '/api/users/1/avatar-photo', headers: { cookie: alice } });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toContain('image/png');
    expect(img.rawPayload.equals(PNG)).toBe(true);
  });

  it('404s for users without a photo; rejects unsupported types', async () => {
    const alice = await signup('alice');
    const missing = await app.inject({ method: 'GET', url: '/api/users/1/avatar-photo', headers: { cookie: alice } });
    expect(missing.statusCode).toBe(404);

    const bad = await app.inject({
      method: 'PUT',
      url: '/api/me/avatar-photo',
      headers: { cookie: alice, 'content-type': 'image/gif' },
      payload: PNG,
    });
    expect([400, 415]).toContain(bad.statusCode);
  });

  it('can switch back to initials and back to the uploaded photo', async () => {
    const alice = await signup('alice');
    await app.inject({ method: 'PUT', url: '/api/me/avatar-photo', headers: { cookie: alice, 'content-type': 'image/jpeg' }, payload: PNG });
    const toInitials = await app.inject({
      method: 'PATCH', url: '/api/me/profile', headers: { cookie: alice },
      payload: { avatar: { kind: 'initials', color: 'auto' } },
    });
    expect(toInitials.statusCode).toBe(200);
    const backToPhoto = await app.inject({
      method: 'PATCH', url: '/api/me/profile', headers: { cookie: alice },
      payload: { avatar: { kind: 'photo' } },
    });
    expect(backToPhoto.statusCode).toBe(200);

    // but a user who never uploaded can't claim kind=photo
    const bob = await signup('bob');
    const invalid = await app.inject({
      method: 'PATCH', url: '/api/me/profile', headers: { cookie: bob },
      payload: { avatar: { kind: 'photo' } },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
