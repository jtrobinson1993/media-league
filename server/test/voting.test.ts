import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let app: FastifyInstance;
let db: DB;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildApp({ config: loadConfig({}), db, media: {} });
});

async function signup(username: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password: 'password1' } });
  return `ml_session=${res.cookies.find((c) => c.name === 'ml_session')!.value}`;
}

interface Ctx {
  cookies: Record<string, string>;
  leagueId: number;
  roundId: number;
  itemsByOwner: Record<string, number>; // username -> ballot item id (their submission)
}

/** 3 players, everyone submits, round advanced to voting. */
async function setupVoting(leagueExtras: Record<string, unknown> = {}, roundExtras: Record<string, unknown> = {}): Promise<Ctx> {
  const names = ['alice', 'bob', 'cara'];
  const cookies: Record<string, string> = {};
  for (const n of names) cookies[n] = await signup(n);

  const g = await app.inject({ method: 'POST', url: '/api/groups', headers: { cookie: cookies.alice }, payload: { name: 'Club' } });
  const groupId = g.json().group.id;
  const inv = await app.inject({ method: 'GET', url: `/api/groups/${groupId}/invites`, headers: { cookie: cookies.alice } });
  for (const n of ['bob', 'cara']) {
    await app.inject({ method: 'POST', url: `/api/invites/${inv.json().standing.code}/accept`, headers: { cookie: cookies[n] } });
  }
  const lg = await app.inject({
    method: 'POST', url: `/api/groups/${groupId}/leagues`, headers: { cookie: cookies.alice },
    payload: { name: 'L', ...leagueExtras },
  });
  const leagueId = lg.json().league.id;
  for (const n of ['bob', 'cara']) {
    await app.inject({ method: 'POST', url: `/api/leagues/${leagueId}/join`, headers: { cookie: cookies[n] } });
  }

  const now = Date.now();
  const r = await app.inject({
    method: 'POST', url: `/api/leagues/${leagueId}/rounds`, headers: { cookie: cookies.alice },
    payload: {
      promptTitle: 'indie horror',
      submitOpenAt: now - 1000,
      submitCloseAt: now + 3_600_000,
      voteCloseAt: now + 7_200_000,
      ...roundExtras,
    },
  });
  const roundId = r.json().rounds[0].id;

  const titles: Record<string, string> = { alice: 'Hereditary', bob: 'It Follows', cara: 'Saint Maud' };
  const itemsByOwner: Record<string, number> = {};
  for (const [i, n] of names.entries()) {
    const res = await app.inject({
      method: 'PUT', url: `/api/rounds/${roundId}/submission`, headers: { cookie: cookies[n] },
      payload: { item: { providerType: 'tmdb', externalId: String(i + 1), title: titles[n], year: 2018 } },
    });
    itemsByOwner[n] = res.json().submission.id;
  }
  await app.inject({ method: 'POST', url: `/api/rounds/${roundId}/advance`, headers: { cookie: cookies.alice } });
  return { cookies, leagueId, roundId, itemsByOwner };
}

describe('pool voting', () => {
  it('excludes own film, validates budget/cap, and scores with coins', async () => {
    const { cookies, leagueId, roundId, itemsByOwner } = await setupVoting();

    const ballot = await app.inject({ method: 'GET', url: `/api/rounds/${roundId}/ballot`, headers: { cookie: cookies.alice } });
    const ids = ballot.json().items.map((i: { id: number }) => i.id);
    expect(ids).not.toContain(itemsByOwner.alice); // self excluded
    expect(ids).toHaveLength(2);

    // overspend rejected
    const over = await app.inject({
      method: 'PUT', url: `/api/rounds/${roundId}/ballot`, headers: { cookie: cookies.alice },
      payload: { allocations: [{ submissionId: itemsByOwner.bob, points: 11 }] },
    });
    expect(over.statusCode).toBe(400);

    // own film rejected
    const self = await app.inject({
      method: 'PUT', url: `/api/rounds/${roundId}/ballot`, headers: { cookie: cookies.alice },
      payload: { allocations: [{ submissionId: itemsByOwner.alice, points: 10 }] },
    });
    expect(self.statusCode).toBe(400);

    // valid ballots (mustSpendAll default): alice 7/3, bob 10 to alice, cara 6/4
    const put = (cookie: string, allocations: unknown) =>
      app.inject({ method: 'PUT', url: `/api/rounds/${roundId}/ballot`, headers: { cookie }, payload: { allocations } });
    expect(
      (await put(cookies.alice, [
        { submissionId: itemsByOwner.bob, points: 7, note: 'watched this on my birthday!' },
        { submissionId: itemsByOwner.cara, points: 3 },
      ])).statusCode,
    ).toBe(200);
    expect((await put(cookies.bob, [{ submissionId: itemsByOwner.alice, points: 10 }])).statusCode).toBe(200);
    expect(
      (await put(cookies.cara, [
        { submissionId: itemsByOwner.alice, points: 6 },
        { submissionId: itemsByOwner.bob, points: 4 },
      ])).statusCode,
    ).toBe(200);

    await app.inject({ method: 'POST', url: `/api/rounds/${roundId}/advance`, headers: { cookie: cookies.alice } });

    const results = await app.inject({ method: 'GET', url: `/api/rounds/${roundId}/results`, headers: { cookie: cookies.bob } });
    const items = results.json().items;
    // alice 16, bob 11, cara 3
    expect(items[0].submitters[0].username).toBe('alice');
    expect(items[0].score).toBe(16);
    expect(items[0].placement).toBe(1);
    expect(items[0].votes.find((v: { voter: { username: string } }) => v.voter.username === 'bob').points).toBe(10);
    // notes revealed attributed
    const bobEntry = items.find((i: { submitters: { username: string }[] }) => i.submitters[0].username === 'bob');
    expect(bobEntry.votes.find((v: { note: string | null }) => v.note)?.note).toMatch(/birthday/);

    // coins: alice 5+30, bob 5+20, cara 5+10
    const coins = (username: string) =>
      (db.prepare('SELECT coins FROM users WHERE username = ?').get(username) as { coins: number }).coins;
    expect(coins('alice')).toBe(35);
    expect(coins('bob')).toBe(25);
    expect(coins('cara')).toBe(15);

    // standings reflect scores
    const standings = await app.inject({ method: 'GET', url: `/api/leagues/${leagueId}/standings`, headers: { cookie: cookies.alice } });
    expect(standings.json().standings[0]).toMatchObject({ username: 'alice', points: 16, rank: 1, wins: 1 });
  });

  it('ties produce co-winners with full podium coins each', async () => {
    const { cookies, roundId, itemsByOwner } = await setupVoting();
    const put = (cookie: string, allocations: unknown) =>
      app.inject({ method: 'PUT', url: `/api/rounds/${roundId}/ballot`, headers: { cookie }, payload: { allocations } });
    // alice→bob 10, bob→alice 10, cara→5/5 ⇒ alice 15, bob 15, cara 0
    await put(cookies.alice, [{ submissionId: itemsByOwner.bob, points: 10 }]);
    await put(cookies.bob, [{ submissionId: itemsByOwner.alice, points: 10 }]);
    await put(cookies.cara, [
      { submissionId: itemsByOwner.alice, points: 5 },
      { submissionId: itemsByOwner.bob, points: 5 },
    ]);
    await app.inject({ method: 'POST', url: `/api/rounds/${roundId}/advance`, headers: { cookie: cookies.alice } });

    const results = await app.inject({ method: 'GET', url: `/api/rounds/${roundId}/results`, headers: { cookie: cookies.cara } });
    const items = results.json().items;
    expect(items[0].placement).toBe(1);
    expect(items[1].placement).toBe(1); // co-winners
    expect(items[2].placement).toBe(3); // standard competition ranking

    const coins = (u: string) => (db.prepare('SELECT coins FROM users WHERE username = ?').get(u) as { coins: number }).coins;
    expect(coins('alice')).toBe(35); // both winners get full 30
    expect(coins('bob')).toBe(35);
    expect(coins('cara')).toBe(15); // 3rd place podium
  });

  it('requireSubmissionToVote gates the ballot', async () => {
    const { cookies, leagueId } = await setupVoting();
    // dave joins but never submitted
    const dave = await signup('dave');
    const league = await app.inject({ method: 'GET', url: `/api/leagues/${leagueId}`, headers: { cookie: cookies.alice } });
    const groupId = league.json().league.groupId;
    const inv = await app.inject({ method: 'GET', url: `/api/groups/${groupId}/invites`, headers: { cookie: cookies.alice } });
    await app.inject({ method: 'POST', url: `/api/invites/${inv.json().standing.code}/accept`, headers: { cookie: dave } });
    await app.inject({ method: 'POST', url: `/api/leagues/${leagueId}/join`, headers: { cookie: dave } });

    const rounds = await app.inject({ method: 'GET', url: `/api/leagues/${leagueId}/rounds`, headers: { cookie: dave } });
    const roundId = rounds.json().rounds[0].id;
    const res = await app.inject({ method: 'GET', url: `/api/rounds/${roundId}/ballot`, headers: { cookie: dave } });
    expect(res.statusCode).toBe(403);
  });
});

describe('ranked voting', () => {
  it('validates ranks and scores by auto weights', async () => {
    const { cookies, roundId, itemsByOwner } = await setupVoting({}, {
      votingConfig: { method: 'ranked', numRanks: 3 },
    });
    // numRanks clamps to 2 eligible items per voter
    const bad = await app.inject({
      method: 'PUT', url: `/api/rounds/${roundId}/ballot`, headers: { cookie: cookies.alice },
      payload: { ranks: [{ submissionId: itemsByOwner.bob, rank: 3 }] },
    });
    expect(bad.statusCode).toBe(400); // rank 3 > clamped K=2

    const put = (cookie: string, ranks: unknown) =>
      app.inject({ method: 'PUT', url: `/api/rounds/${roundId}/ballot`, headers: { cookie }, payload: { ranks } });
    expect(
      (await put(cookies.alice, [
        { submissionId: itemsByOwner.bob, rank: 1, note: 'brilliant' },
        { submissionId: itemsByOwner.cara, rank: 2 },
      ])).statusCode,
    ).toBe(200);
    expect((await put(cookies.bob, [{ submissionId: itemsByOwner.alice, rank: 1 }])).statusCode).toBe(200);
    expect(
      (await put(cookies.cara, [
        { submissionId: itemsByOwner.bob, rank: 1 },
        { submissionId: itemsByOwner.alice, rank: 2 },
      ])).statusCode,
    ).toBe(200);

    await app.inject({ method: 'POST', url: `/api/rounds/${roundId}/advance`, headers: { cookie: cookies.alice } });
    const results = await app.inject({ method: 'GET', url: `/api/rounds/${roundId}/results`, headers: { cookie: cookies.bob } });
    const items = results.json().items;
    // weights auto = [3,2] after clamp: bob = 3+3=6? wait — weights resolve from numRanks=3: [3,2,1]; rank1=3, rank2=2
    // bob: alice r1(3) + cara r1(3) = 6; alice: bob r1(3) + cara r2(2) = 5; cara: alice r2(2)
    expect(items[0].submitters[0].username).toBe('bob');
    expect(items[0].score).toBe(6);
    expect(items[1].score).toBe(5);
    expect(items[2].score).toBe(2);
  });
});

describe('duplicate merging in scoring', () => {
  it('co-submitters of a merged winner each get full credit and coins', async () => {
    // duplicates allowed; alice and bob both pick externalId 9
    const names = ['alice', 'bob', 'cara'];
    const cookies: Record<string, string> = {};
    for (const n of names) cookies[n] = await signup(n);
    const g = await app.inject({ method: 'POST', url: '/api/groups', headers: { cookie: cookies.alice }, payload: { name: 'C' } });
    const groupId = g.json().group.id;
    const inv = await app.inject({ method: 'GET', url: `/api/groups/${groupId}/invites`, headers: { cookie: cookies.alice } });
    for (const n of ['bob', 'cara']) {
      await app.inject({ method: 'POST', url: `/api/invites/${inv.json().standing.code}/accept`, headers: { cookie: cookies[n] } });
    }
    const lg = await app.inject({
      method: 'POST', url: `/api/groups/${groupId}/leagues`, headers: { cookie: cookies.alice },
      payload: { name: 'L', allowDuplicates: true },
    });
    const leagueId = lg.json().league.id;
    for (const n of ['bob', 'cara']) await app.inject({ method: 'POST', url: `/api/leagues/${leagueId}/join`, headers: { cookie: cookies[n] } });
    const now = Date.now();
    const r = await app.inject({
      method: 'POST', url: `/api/leagues/${leagueId}/rounds`, headers: { cookie: cookies.alice },
      payload: { promptTitle: 'p', submitOpenAt: now - 1000, submitCloseAt: now + 3_600_000, voteCloseAt: now + 7_200_000 },
    });
    const roundId = r.json().rounds[0].id;
    for (const n of ['alice', 'bob']) {
      await app.inject({
        method: 'PUT', url: `/api/rounds/${roundId}/submission`, headers: { cookie: cookies[n] },
        payload: { item: { providerType: 'tmdb', externalId: '9', title: 'Hereditary' } },
      });
    }
    await app.inject({
      method: 'PUT', url: `/api/rounds/${roundId}/submission`, headers: { cookie: cookies.cara },
      payload: { item: { providerType: 'tmdb', externalId: '2', title: 'It Follows' } },
    });
    await app.inject({ method: 'POST', url: `/api/rounds/${roundId}/advance`, headers: { cookie: cookies.alice } });

    // cara votes 10 on the merged Hereditary entry (only eligible item for her... plus none)
    const ballot = await app.inject({ method: 'GET', url: `/api/rounds/${roundId}/ballot`, headers: { cookie: cookies.cara } });
    const hereditary = ballot.json().items.find((i: { title: string }) => i.title === 'Hereditary');
    await app.inject({
      method: 'PUT', url: `/api/rounds/${roundId}/ballot`, headers: { cookie: cookies.cara },
      payload: { allocations: [{ submissionId: hereditary.id, points: 10 }] },
    });
    await app.inject({ method: 'POST', url: `/api/rounds/${roundId}/advance`, headers: { cookie: cookies.alice } });

    const coins = (u: string) => (db.prepare('SELECT coins FROM users WHERE username = ?').get(u) as { coins: number }).coins;
    expect(coins('alice')).toBe(35); // full winner credit each (SPEC §11)
    expect(coins('bob')).toBe(35);

    const standings = await app.inject({ method: 'GET', url: `/api/leagues/${leagueId}/standings`, headers: { cookie: cookies.alice } });
    const byName = Object.fromEntries(standings.json().standings.map((s: { username: string; points: number }) => [s.username, s.points]));
    expect(byName.alice).toBe(10);
    expect(byName.bob).toBe(10);
  });
});
