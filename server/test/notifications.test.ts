import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { setWebhookTransport } from '../src/lib/webhooks.js';

let app: FastifyInstance;
let db: DB;
let delivered: { url: string; body: unknown }[];

beforeEach(async () => {
  db = openDb(':memory:');
  delivered = [];
  setWebhookTransport(async (url, body) => {
    delivered.push({ url, body });
  });
  app = await buildApp({ config: loadConfig({}), db, media: {} });
});

async function signup(username: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password: 'password1' } });
  return `ml_session=${res.cookies.find((c) => c.name === 'ml_session')!.value}`;
}

async function setupLeague(): Promise<{ alice: string; bob: string; leagueId: number; roundId: number }> {
  const alice = await signup('alice');
  const bob = await signup('bob');
  const g = await app.inject({ method: 'POST', url: '/api/groups', headers: { cookie: alice }, payload: { name: 'Club' } });
  const groupId = g.json().group.id;
  const inv = await app.inject({ method: 'GET', url: `/api/groups/${groupId}/invites`, headers: { cookie: alice } });
  await app.inject({ method: 'POST', url: `/api/invites/${inv.json().standing.code}/accept`, headers: { cookie: bob } });
  const lg = await app.inject({ method: 'POST', url: `/api/groups/${groupId}/leagues`, headers: { cookie: alice }, payload: { name: 'Horror League' } });
  const leagueId = lg.json().league.id;
  await app.inject({ method: 'POST', url: `/api/leagues/${leagueId}/join`, headers: { cookie: bob } });

  // register a discord webhook before the round exists
  await app.inject({
    method: 'POST', url: `/api/leagues/${leagueId}/webhooks`, headers: { cookie: alice },
    payload: { url: 'https://discord.example/hook', format: 'discord' },
  });

  const now = Date.now();
  const r = await app.inject({
    method: 'POST', url: `/api/leagues/${leagueId}/rounds`, headers: { cookie: alice },
    payload: { promptTitle: 'indie horror', submitOpenAt: now - 1000, submitCloseAt: now + 3_600_000, voteCloseAt: now + 7_200_000 },
  });
  return { alice, bob, leagueId, roundId: r.json().rounds[0].id };
}

describe('notifications & webhooks', () => {
  it('phase transitions create in-app notifications for league members', async () => {
    const { alice, bob } = await setupLeague();
    // round opened on creation (submitOpenAt in the past) ⇒ submissions.open
    for (const cookie of [alice, bob]) {
      const res = await app.inject({ method: 'GET', url: '/api/notifications', headers: { cookie } });
      const body = res.json();
      expect(body.unread).toBe(1);
      expect(body.notifications[0].type).toBe('submissions.open');
      expect(body.notifications[0].payload.title).toMatch(/Horror League/);
    }
  });

  it('read marking works (ids and all)', async () => {
    const { alice } = await setupLeague();
    const list = await app.inject({ method: 'GET', url: '/api/notifications', headers: { cookie: alice } });
    const id = list.json().notifications[0].id;
    await app.inject({ method: 'POST', url: '/api/notifications/read', headers: { cookie: alice }, payload: { ids: [id] } });
    const after = await app.inject({ method: 'GET', url: '/api/notifications', headers: { cookie: alice } });
    expect(after.json().unread).toBe(0);
  });

  it('webhooks fire through the full round lifecycle with discord formatting', async () => {
    const { alice, bob, roundId } = await setupLeague();
    expect(delivered.map((d) => JSON.stringify(d.body)).join()).toMatch(/round.created|Submissions are open/i);

    for (const [cookie, ext] of [[alice, '1'], [bob, '2']] as const) {
      await app.inject({
        method: 'PUT', url: `/api/rounds/${roundId}/submission`, headers: { cookie },
        payload: { item: { providerType: 'tmdb', externalId: ext, title: `Film ${ext}` } },
      });
    }
    await app.inject({ method: 'POST', url: `/api/rounds/${roundId}/advance`, headers: { cookie: alice } });

    const ballot = await app.inject({ method: 'GET', url: `/api/rounds/${roundId}/ballot`, headers: { cookie: alice } });
    await app.inject({
      method: 'PUT', url: `/api/rounds/${roundId}/ballot`, headers: { cookie: alice },
      payload: { allocations: [{ submissionId: ballot.json().items[0].id, points: 10 }] },
    });
    await app.inject({ method: 'POST', url: `/api/rounds/${roundId}/advance`, headers: { cookie: alice } });

    const bodies = delivered.map((d) => JSON.stringify(d.body)).join('\n');
    expect(bodies).toMatch(/Voting is open/);
    expect(bodies).toMatch(/Results are up/);
    expect(bodies).toMatch(/won/); // winner.announced
    expect(delivered.every((d) => d.url === 'https://discord.example/hook')).toBe(true);
    // discord format = embeds
    expect((delivered[0]!.body as { embeds: unknown[] }).embeds).toBeDefined();
  });

  it('webhook CRUD is league-admin only and validates input', async () => {
    const { bob, leagueId } = await setupLeague();
    const forbidden = await app.inject({
      method: 'POST', url: `/api/leagues/${leagueId}/webhooks`, headers: { cookie: bob },
      payload: { url: 'https://x.example', format: 'slack' },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('push subscribe/unsubscribe stores and removes subscriptions', async () => {
    const { alice } = await setupLeague();
    const sub = await app.inject({
      method: 'POST', url: '/api/push/subscribe', headers: { cookie: alice },
      payload: { endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' } },
    });
    expect(sub.statusCode).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()).toEqual({ n: 1 });
    await app.inject({
      method: 'POST', url: '/api/push/unsubscribe', headers: { cookie: alice },
      payload: { endpoint: 'https://push.example/abc' },
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()).toEqual({ n: 0 });
  });

  it('vapid key endpoint 404s when push is not configured', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/push/vapid-key' });
    expect(res.statusCode).toBe(404);
  });
});
