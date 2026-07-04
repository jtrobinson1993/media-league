import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { MediaItem } from '@media-league/shared';
import { openDb, type DB } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { MediaProvider } from '../src/lib/media.js';

let app: FastifyInstance;
let db: DB;
let searchCalls = 0;

const fakeProvider: MediaProvider = {
  providerType: 'tmdb',
  async search(query: string): Promise<MediaItem[]> {
    searchCalls++;
    return [
      { providerType: 'tmdb', externalId: '1', title: `${query} One`, subtitle: null, year: 2018, imageUrl: null },
      { providerType: 'tmdb', externalId: '2', title: `${query} Two`, subtitle: null, year: 2019, imageUrl: null },
    ];
  },
};

beforeEach(async () => {
  db = openDb(':memory:');
  searchCalls = 0;
  app = await buildApp({ config: loadConfig({}), db, media: { movie: fakeProvider } });
});

async function signup(username: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password: 'password1' } });
  return `ml_session=${res.cookies.find((c) => c.name === 'ml_session')!.value}`;
}

interface Ctx {
  alice: string;
  bob: string;
  cara: string;
  leagueId: number;
  roundId: number;
}

async function setup(leagueExtras: Record<string, unknown> = {}): Promise<Ctx> {
  const alice = await signup('alice');
  const bob = await signup('bob');
  const cara = await signup('cara');
  const g = await app.inject({ method: 'POST', url: '/api/groups', headers: { cookie: alice }, payload: { name: 'Club' } });
  const groupId = g.json().group.id;
  const inv = await app.inject({ method: 'GET', url: `/api/groups/${groupId}/invites`, headers: { cookie: alice } });
  const code = inv.json().standing.code;
  for (const c of [bob, cara]) {
    await app.inject({ method: 'POST', url: `/api/invites/${code}/accept`, headers: { cookie: c } });
  }
  const lg = await app.inject({
    method: 'POST', url: `/api/groups/${groupId}/leagues`, headers: { cookie: alice },
    payload: { name: 'L', ...leagueExtras },
  });
  const leagueId = lg.json().league.id;
  for (const c of [bob, cara]) {
    await app.inject({ method: 'POST', url: `/api/leagues/${leagueId}/join`, headers: { cookie: c } });
  }
  const now = Date.now();
  const r = await app.inject({
    method: 'POST', url: `/api/leagues/${leagueId}/rounds`, headers: { cookie: alice },
    payload: { promptTitle: 'indie horror', submitOpenAt: now - 1000, submitCloseAt: now + 3_600_000, voteCloseAt: now + 7_200_000 },
  });
  return { alice, bob, cara, leagueId, roundId: r.json().rounds[0].id };
}

const item = (externalId: string, title: string) => ({
  item: { providerType: 'tmdb', externalId, title, year: 2018 },
});

describe('submissions', () => {
  it('search proxies the provider and caches results', async () => {
    const { alice, leagueId } = await setup();
    const r1 = await app.inject({ method: 'GET', url: `/api/leagues/${leagueId}/search?q=hered`, headers: { cookie: alice } });
    expect(r1.json().items).toHaveLength(2);
    await app.inject({ method: 'GET', url: `/api/leagues/${leagueId}/search?q=hered`, headers: { cookie: alice } });
    expect(searchCalls).toBe(1); // second hit served from cache
  });

  it('submit, change, and delete own pick while open', async () => {
    const { alice, roundId } = await setup();
    const put = await app.inject({ method: 'PUT', url: `/api/rounds/${roundId}/submission`, headers: { cookie: alice }, payload: item('1', 'Hereditary') });
    expect(put.statusCode).toBe(200);

    const change = await app.inject({ method: 'PUT', url: `/api/rounds/${roundId}/submission`, headers: { cookie: alice }, payload: { freeText: 'Obscure Film 1999' } });
    expect(change.json().submission.isFreeText).toBe(true);

    const list = await app.inject({ method: 'GET', url: `/api/rounds/${roundId}/submissions`, headers: { cookie: alice } });
    expect(list.json().mine.title).toBe('Obscure Film 1999');

    const del = await app.inject({ method: 'DELETE', url: `/api/rounds/${roundId}/submission`, headers: { cookie: alice } });
    expect(del.statusCode).toBe(200);
  });

  it('blocks duplicates anonymously when allowDuplicates is off', async () => {
    const { alice, bob, roundId } = await setup();
    await app.inject({ method: 'PUT', url: `/api/rounds/${roundId}/submission`, headers: { cookie: alice }, payload: item('1', 'Hereditary') });
    const dupe = await app.inject({ method: 'PUT', url: `/api/rounds/${roundId}/submission`, headers: { cookie: bob }, payload: item('1', 'Hereditary') });
    expect(dupe.statusCode).toBe(409);
    expect(JSON.stringify(dupe.json())).not.toMatch(/alice/);
  });

  it('merges duplicates into one anonymous ballot entry when allowed', async () => {
    const { alice, bob, cara, roundId } = await setup({ allowDuplicates: true });
    await app.inject({ method: 'PUT', url: `/api/rounds/${roundId}/submission`, headers: { cookie: alice }, payload: item('1', 'Hereditary') });
    await app.inject({ method: 'PUT', url: `/api/rounds/${roundId}/submission`, headers: { cookie: bob }, payload: item('1', 'Hereditary') });
    await app.inject({ method: 'PUT', url: `/api/rounds/${roundId}/submission`, headers: { cookie: cara }, payload: item('2', 'It Follows') });
    await app.inject({ method: 'POST', url: `/api/rounds/${roundId}/advance`, headers: { cookie: alice } });

    const list = await app.inject({ method: 'GET', url: `/api/rounds/${roundId}/submissions`, headers: { cookie: cara } });
    const body = list.json();
    expect(body.phase).toBe('voting');
    expect(body.items).toHaveLength(2); // merged
    expect(JSON.stringify(body.items)).not.toMatch(/alice|bob|cara|submitter/);
    const hereditary = body.items.find((i: { title: string }) => i.title === 'Hereditary');
    expect(hereditary.mine).toBe(false); // cara didn't submit it
  });

  it('voting phase hides authors; finished reveals them', async () => {
    const { alice, bob, roundId } = await setup();
    await app.inject({ method: 'PUT', url: `/api/rounds/${roundId}/submission`, headers: { cookie: alice }, payload: item('1', 'Hereditary') });
    await app.inject({ method: 'PUT', url: `/api/rounds/${roundId}/submission`, headers: { cookie: bob }, payload: item('2', 'It Follows') });
    await app.inject({ method: 'POST', url: `/api/rounds/${roundId}/advance`, headers: { cookie: alice } });

    const during = await app.inject({ method: 'GET', url: `/api/rounds/${roundId}/submissions`, headers: { cookie: alice } });
    expect(JSON.stringify(during.json().items)).not.toMatch(/submitter/);

    // cast a ballot so close doesn't void, then finish
    db.prepare('INSERT INTO votes (round_id, voter_id, submission_id, points) VALUES (?, 1, ?, 5)').run(
      roundId,
      during.json().items[0].id,
    );
    await app.inject({ method: 'POST', url: `/api/rounds/${roundId}/advance`, headers: { cookie: alice } });

    const after = await app.inject({ method: 'GET', url: `/api/rounds/${roundId}/submissions`, headers: { cookie: bob } });
    expect(after.json().phase).toBe('finished');
    const titles = after.json().items.map((i: { submitter: { username: string } }) => i.submitter.username);
    expect(titles).toContain('alice');
  });

  it('rejects submissions outside the window', async () => {
    const { alice, bob, roundId } = await setup();
    await app.inject({ method: 'PUT', url: `/api/rounds/${roundId}/submission`, headers: { cookie: alice }, payload: item('1', 'A') });
    await app.inject({ method: 'PUT', url: `/api/rounds/${roundId}/submission`, headers: { cookie: bob }, payload: item('2', 'B') });
    await app.inject({ method: 'POST', url: `/api/rounds/${roundId}/advance`, headers: { cookie: alice } });
    const late = await app.inject({ method: 'PUT', url: `/api/rounds/${roundId}/submission`, headers: { cookie: alice }, payload: item('3', 'C') });
    expect(late.statusCode).toBe(400);
  });
});
