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
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password: 'password1' } });
  return `ml_session=${res.cookies.find((c) => c.name === 'ml_session')!.value}`;
}

async function setup(): Promise<{ alice: string; bob: string; groupId: number }> {
  const alice = await signup('alice');
  const bob = await signup('bob');
  const g = await app.inject({ method: 'POST', url: '/api/groups', headers: { cookie: alice }, payload: { name: 'Club' } });
  const groupId = g.json().group.id;
  const inv = await app.inject({ method: 'GET', url: `/api/groups/${groupId}/invites`, headers: { cookie: alice } });
  await app.inject({ method: 'POST', url: `/api/invites/${inv.json().standing.code}/accept`, headers: { cookie: bob } });
  return { alice, bob, groupId };
}

describe('leagues', () => {
  it('any group member can create a league and becomes its admin', async () => {
    const { bob, groupId } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: `/api/groups/${groupId}/leagues`,
      headers: { cookie: bob },
      payload: { name: 'Movie Snob Movie League' },
    });
    expect(res.statusCode).toBe(200);
    const detail = await app.inject({ method: 'GET', url: `/api/leagues/${res.json().league.id}`, headers: { cookie: bob } });
    expect(detail.json().myRole).toBe('admin');
    expect(detail.json().league.defaultVotingConfig.method).toBe('pool');
  });

  it('public leagues are joinable by group members; private need an invite', async () => {
    const { alice, bob, groupId } = await setup();
    const pub = await app.inject({
      method: 'POST', url: `/api/groups/${groupId}/leagues`, headers: { cookie: alice },
      payload: { name: 'Public L' },
    });
    const priv = await app.inject({
      method: 'POST', url: `/api/groups/${groupId}/leagues`, headers: { cookie: alice },
      payload: { name: 'Private L', visibility: 'private' },
    });

    const joinPub = await app.inject({ method: 'POST', url: `/api/leagues/${pub.json().league.id}/join`, headers: { cookie: bob } });
    expect(joinPub.statusCode).toBe(200);

    const privId = priv.json().league.id;
    const joinPriv = await app.inject({ method: 'POST', url: `/api/leagues/${privId}/join`, headers: { cookie: bob } });
    expect(joinPriv.statusCode).toBe(403);
    const view = await app.inject({ method: 'GET', url: `/api/leagues/${privId}`, headers: { cookie: bob } });
    expect(view.statusCode).toBe(403);

    // league standing invite lets bob in (and it's not listed in group detail until then)
    const invites = await app.inject({ method: 'GET', url: `/api/leagues/${privId}/invites`, headers: { cookie: alice } });
    const accept = await app.inject({
      method: 'POST', url: `/api/invites/${invites.json().standing.code}/accept`, headers: { cookie: bob },
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().joined.leagueId).toBe(privId);
    const viewAfter = await app.inject({ method: 'GET', url: `/api/leagues/${privId}`, headers: { cookie: bob } });
    expect(viewAfter.statusCode).toBe(200);
  });

  it('league invite onboards a non-group-member into group AND league', async () => {
    const { alice, groupId } = await setup();
    const lg = await app.inject({
      method: 'POST', url: `/api/groups/${groupId}/leagues`, headers: { cookie: alice },
      payload: { name: 'L', visibility: 'private' },
    });
    const leagueId = lg.json().league.id;
    const invites = await app.inject({ method: 'GET', url: `/api/leagues/${leagueId}/invites`, headers: { cookie: alice } });

    const cara = await signup('cara');
    const accept = await app.inject({
      method: 'POST', url: `/api/invites/${invites.json().standing.code}/accept`, headers: { cookie: cara },
    });
    expect(accept.json().joined).toEqual({ groupId, leagueId });
    const groupDetail = await app.inject({ method: 'GET', url: `/api/groups/${groupId}`, headers: { cookie: cara } });
    expect(groupDetail.statusCode).toBe(200);
  });

  it('group admin has moderation oversight: can delete a league they do not run', async () => {
    const { alice, bob, groupId } = await setup();
    const lg = await app.inject({
      method: 'POST', url: `/api/groups/${groupId}/leagues`, headers: { cookie: bob }, payload: { name: 'Bobs L' },
    });
    const leagueId = lg.json().league.id;

    // alice is group admin but not league admin — can reassign + delete
    const reassign = await app.inject({
      method: 'POST', url: `/api/leagues/${leagueId}/members/1/role`, headers: { cookie: alice }, payload: { role: 'admin' },
    });
    expect(reassign.statusCode).toBe(404); // alice not a league member yet — join first
    await app.inject({ method: 'POST', url: `/api/leagues/${leagueId}/join`, headers: { cookie: alice } });
    const reassign2 = await app.inject({
      method: 'POST', url: `/api/leagues/${leagueId}/members/1/role`, headers: { cookie: alice }, payload: { role: 'admin' },
    });
    expect(reassign2.statusCode).toBe(200);

    const del = await app.inject({ method: 'DELETE', url: `/api/leagues/${leagueId}`, headers: { cookie: alice } });
    expect(del.statusCode).toBe(200);
  });

  it('league settings update validates voting config', async () => {
    const { alice, groupId } = await setup();
    const lg = await app.inject({
      method: 'POST', url: `/api/groups/${groupId}/leagues`, headers: { cookie: alice }, payload: { name: 'L' },
    });
    const id = lg.json().league.id;

    const bad = await app.inject({
      method: 'PATCH', url: `/api/leagues/${id}`, headers: { cookie: alice },
      payload: { defaultVotingConfig: { method: 'pool', totalPoints: 0 } },
    });
    expect(bad.statusCode).toBe(400);

    const good = await app.inject({
      method: 'PATCH', url: `/api/leagues/${id}`, headers: { cookie: alice },
      payload: {
        defaultVotingConfig: { method: 'ranked', numRanks: 3, weights: [5, 3, 1] },
        scheduleTemplate: { startWeekday: 5, startTime: '18:00', submissionDays: 3, votingDays: 3 },
        promptMode: 'winner-picks-next',
      },
    });
    expect(good.statusCode).toBe(200);
    const detail = await app.inject({ method: 'GET', url: `/api/leagues/${id}`, headers: { cookie: alice } });
    expect(detail.json().league.promptMode).toBe('winner-picks-next');
    expect(detail.json().league.scheduleTemplate.startWeekday).toBe(5);
  });
});
