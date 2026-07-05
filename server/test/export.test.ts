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

/** Build a league with one finished round (alice wins 10-0). */
async function playedLeague(): Promise<{ alice: string; leagueId: number }> {
  const alice = await signup('alice');
  const bob = await signup('bob');
  const g = await app.inject({ method: 'POST', url: '/api/groups', headers: { cookie: alice }, payload: { name: 'Club' } });
  const inv = await app.inject({ method: 'GET', url: `/api/groups/${g.json().group.id}/invites`, headers: { cookie: alice } });
  await app.inject({ method: 'POST', url: `/api/invites/${inv.json().standing.code}/accept`, headers: { cookie: bob } });
  const lg = await app.inject({ method: 'POST', url: `/api/groups/${g.json().group.id}/leagues`, headers: { cookie: alice }, payload: { name: 'Export, "League"' } });
  const leagueId = lg.json().league.id;
  await app.inject({ method: 'POST', url: `/api/leagues/${leagueId}/join`, headers: { cookie: bob } });
  const now = Date.now();
  const r = await app.inject({
    method: 'POST', url: `/api/leagues/${leagueId}/rounds`, headers: { cookie: alice },
    payload: { promptTitle: 'p1', submitOpenAt: now - 1000, submitCloseAt: now + 3_600_000, voteCloseAt: now + 7_200_000 },
  });
  const roundId = r.json().rounds[0].id;
  for (const [c, ext, title] of [[alice, '1', 'Hereditary'], [bob, '2', 'It Follows']] as const) {
    await app.inject({ method: 'PUT', url: `/api/rounds/${roundId}/submission`, headers: { cookie: c }, payload: { item: { providerType: 'tmdb', externalId: ext, title } } });
  }
  await app.inject({ method: 'POST', url: `/api/rounds/${roundId}/advance`, headers: { cookie: alice } });
  const ballot = await app.inject({ method: 'GET', url: `/api/rounds/${roundId}/ballot`, headers: { cookie: bob } });
  await app.inject({
    method: 'PUT', url: `/api/rounds/${roundId}/ballot`, headers: { cookie: bob },
    payload: { allocations: [{ submissionId: ballot.json().items[0].id, points: 10 }] },
  });
  await app.inject({ method: 'POST', url: `/api/rounds/${roundId}/advance`, headers: { cookie: alice } });
  return { alice, leagueId };
}

describe('league export', () => {
  it('JSON export includes standings and per-round results', async () => {
    const { alice, leagueId } = await playedLeague();
    const res = await app.inject({ method: 'GET', url: `/api/leagues/${leagueId}/export`, headers: { cookie: alice } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('.json');
    const body = res.json();
    expect(body.standings[0]).toMatchObject({ username: 'alice', points: 10, wins: 1 });
    expect(body.results.find((r: { submitter: string }) => r.submitter === 'alice')).toMatchObject({
      roundNumber: 1,
      title: 'Hereditary',
      placement: 1,
    });
  });

  it('CSV export escapes fields and sets download headers', async () => {
    const { alice, leagueId } = await playedLeague();
    const res = await app.inject({ method: 'GET', url: `/api/leagues/${leagueId}/export?format=csv`, headers: { cookie: alice } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('export-league-export.csv');
    expect(res.body).toContain('username,points,wins,roundsPlayed');
    expect(res.body).toContain('Hereditary');
  });

  it('is members-only', async () => {
    const { leagueId } = await playedLeague();
    const outsider = await signup('mallory');
    const res = await app.inject({ method: 'GET', url: `/api/leagues/${leagueId}/export`, headers: { cookie: outsider } });
    expect(res.statusCode).toBe(403);
  });
});
