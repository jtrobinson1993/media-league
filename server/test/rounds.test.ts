import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { tickAll, getRound } from '../src/lib/roundLifecycle.js';

let app: FastifyInstance;
let db: DB;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildApp({ config: loadConfig({}), db });
});

async function signup(username: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password: 'password1' } });
  return `ml_session=${res.cookies.find((c) => c.name === 'ml_session')!.value}`;
}

const HOUR = 3_600_000;

async function makeLeague(cookie: string, extras: Record<string, unknown> = {}): Promise<number> {
  const g = await app.inject({ method: 'POST', url: '/api/groups', headers: { cookie }, payload: { name: 'Club' } });
  const lg = await app.inject({
    method: 'POST',
    url: `/api/groups/${g.json().group.id}/leagues`,
    headers: { cookie },
    payload: { name: 'L', ...extras },
  });
  return lg.json().league.id;
}

function futureRoundPayload(promptTitle = 'favorite indie horror'): Record<string, unknown> {
  const now = Date.now();
  return {
    promptTitle,
    submitOpenAt: now + HOUR,
    submitCloseAt: now + 2 * HOUR,
    voteCloseAt: now + 3 * HOUR,
  };
}

describe('rounds', () => {
  it('creates a round with explicit dates; scheduled until open time', async () => {
    const alice = await signup('alice');
    const leagueId = await makeLeague(alice);
    const res = await app.inject({
      method: 'POST', url: `/api/leagues/${leagueId}/rounds`, headers: { cookie: alice },
      payload: futureRoundPayload(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rounds[0].phase).toBe('scheduled');
  });

  it('bulk-adds rounds from the schedule template with sequential windows', async () => {
    const alice = await signup('alice');
    const leagueId = await makeLeague(alice, {
      scheduleTemplate: { startWeekday: 5, startTime: '18:00', submissionDays: 3, votingDays: 3 },
    });
    const res = await app.inject({
      method: 'POST', url: `/api/leagues/${leagueId}/rounds`, headers: { cookie: alice },
      payload: { count: 3, promptTitle: 'round one prompt' },
    });
    const rounds = res.json().rounds;
    expect(rounds).toHaveLength(3);
    // weekly cadence: each open is 7 days after the previous
    expect(rounds[1].submitOpenAt - rounds[0].submitOpenAt).toBe(7 * 24 * HOUR);
    expect(rounds[2].submitOpenAt - rounds[1].submitOpenAt).toBe(7 * 24 * HOUR);
    // only the first round carries the prompt; the rest are queued unset
    expect(rounds[0].promptTitle).toBe('round one prompt');
    expect(rounds[1].promptTitle).toBeNull();
  });

  it('scheduler opens submissions at the window and voids with <2 submissions at close', async () => {
    const alice = await signup('alice');
    const leagueId = await makeLeague(alice);
    const now = Date.now();
    const res = await app.inject({
      method: 'POST', url: `/api/leagues/${leagueId}/rounds`, headers: { cookie: alice },
      payload: { promptTitle: 'p', submitOpenAt: now + HOUR, submitCloseAt: now + 2 * HOUR, voteCloseAt: now + 3 * HOUR },
    });
    const id = res.json().rounds[0].id;

    tickAll(db, now + HOUR + 1);
    expect(getRound(db, id)!.phase).toBe('submitting');

    tickAll(db, now + 2 * HOUR + 1);
    expect(getRound(db, id)!.phase).toBe('voided'); // no submissions
  });

  it('a round with no prompt does not open; chooser falls back to admin', async () => {
    const alice = await signup('alice');
    const leagueId = await makeLeague(alice);
    const now = Date.now();
    const res = await app.inject({
      method: 'POST', url: `/api/leagues/${leagueId}/rounds`, headers: { cookie: alice },
      payload: { submitOpenAt: now + HOUR, submitCloseAt: now + 2 * HOUR, voteCloseAt: now + 3 * HOUR },
    });
    const id = res.json().rounds[0].id;
    db.prepare('UPDATE rounds SET chooser_id = 1 WHERE id = ?').run(id);

    tickAll(db, now + HOUR + 1);
    const r = getRound(db, id)!;
    expect(r.phase).toBe('scheduled'); // stalls harmlessly, never opens promptless
    expect(r.chooser_id).toBeNull(); // authorship fell back to admin

    // once a prompt is set, next tick opens it
    await app.inject({
      method: 'PATCH', url: `/api/rounds/${id}`, headers: { cookie: alice },
      payload: { promptTitle: 'late prompt' },
    });
    tickAll(db, now + HOUR + 2);
    expect(getRound(db, id)!.phase).toBe('submitting');
  });

  it('manual advance respects the prompt gate and void rules', async () => {
    const alice = await signup('alice');
    const leagueId = await makeLeague(alice);
    const res = await app.inject({
      method: 'POST', url: `/api/leagues/${leagueId}/rounds`, headers: { cookie: alice },
      payload: futureRoundPayload(),
    });
    const id = res.json().rounds[0].id;

    const adv1 = await app.inject({ method: 'POST', url: `/api/rounds/${id}/advance`, headers: { cookie: alice } });
    expect(adv1.json().round.phase).toBe('submitting');

    // advancing out of submitting with <2 submissions voids the round
    const adv2 = await app.inject({ method: 'POST', url: `/api/rounds/${id}/advance`, headers: { cookie: alice } });
    expect(adv2.json().round.phase).toBe('voided');

    const adv3 = await app.inject({ method: 'POST', url: `/api/rounds/${id}/advance`, headers: { cookie: alice } });
    expect(adv3.statusCode).toBe(400);
  });

  it('non-admin members cannot create or advance rounds', async () => {
    const alice = await signup('alice');
    const bob = await signup('bob');
    const leagueId = await makeLeague(alice);
    const league = await app.inject({ method: 'GET', url: `/api/leagues/${leagueId}`, headers: { cookie: alice } });
    const groupId = league.json().league.groupId;
    const inv = await app.inject({ method: 'GET', url: `/api/groups/${groupId}/invites`, headers: { cookie: alice } });
    await app.inject({ method: 'POST', url: `/api/invites/${inv.json().standing.code}/accept`, headers: { cookie: bob } });
    await app.inject({ method: 'POST', url: `/api/leagues/${leagueId}/join`, headers: { cookie: bob } });

    const res = await app.inject({
      method: 'POST', url: `/api/leagues/${leagueId}/rounds`, headers: { cookie: bob },
      payload: futureRoundPayload(),
    });
    expect(res.statusCode).toBe(403);
  });
});
