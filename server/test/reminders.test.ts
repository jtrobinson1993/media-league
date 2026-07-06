import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { sendClosingReminders } from '../src/lib/events.js';

let app: FastifyInstance;
let db: DB;

const HOUR = 3_600_000;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildApp({ config: loadConfig({}), db, media: {} });
});

async function signup(username: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password: 'password1' } });
  return `ml_session=${res.cookies.find((c) => c.name === 'ml_session')!.value}`;
}

function unreadOf(cookieUserId: number, type: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND type = ?').get(cookieUserId, type) as {
      n: number;
    }
  ).n;
}

describe('closing-soon reminders', () => {
  it('nudges only members who have not submitted, exactly once', async () => {
    const alice = await signup('alice');
    const bob = await signup('bob');
    const g = await app.inject({ method: 'POST', url: '/api/groups', headers: { cookie: alice }, payload: { name: 'C' } });
    const inv = await app.inject({ method: 'GET', url: `/api/groups/${g.json().group.id}/invites`, headers: { cookie: alice } });
    await app.inject({ method: 'POST', url: `/api/invites/${inv.json().standing.code}/accept`, headers: { cookie: bob } });
    const lg = await app.inject({ method: 'POST', url: `/api/groups/${g.json().group.id}/leagues`, headers: { cookie: alice }, payload: { name: 'L' } });
    const leagueId = lg.json().league.id;
    await app.inject({ method: 'POST', url: `/api/leagues/${leagueId}/join`, headers: { cookie: bob } });

    const now = Date.now();
    const r = await app.inject({
      method: 'POST', url: `/api/leagues/${leagueId}/rounds`, headers: { cookie: alice },
      payload: { promptTitle: 'p', submitOpenAt: now - 1000, submitCloseAt: now + HOUR, voteCloseAt: now + 3 * HOUR },
    });
    const roundId = r.json().rounds[0].id;

    // alice submits; bob doesn't
    await app.inject({
      method: 'PUT', url: `/api/rounds/${roundId}/submission`, headers: { cookie: alice },
      payload: { item: { providerType: 'tmdb', externalId: '1', title: 'A' } },
    });

    // outside the window: nothing
    sendClosingReminders(db, now - 3 * HOUR);
    expect(unreadOf(2, 'submissions.closing')).toBe(0);

    // inside the 2h window: bob nudged, alice not
    sendClosingReminders(db, now);
    expect(unreadOf(2, 'submissions.closing')).toBe(1);
    expect(unreadOf(1, 'submissions.closing')).toBe(0);

    // one-shot: repeat tick sends nothing new
    sendClosingReminders(db, now + 60_000);
    expect(unreadOf(2, 'submissions.closing')).toBe(1);
  });

  it('voting reminders skip members who already voted', async () => {
    const alice = await signup('alice');
    const bob = await signup('bob');
    const cara = await signup('cara');
    const g = await app.inject({ method: 'POST', url: '/api/groups', headers: { cookie: alice }, payload: { name: 'C' } });
    const inv = await app.inject({ method: 'GET', url: `/api/groups/${g.json().group.id}/invites`, headers: { cookie: alice } });
    for (const c of [bob, cara]) await app.inject({ method: 'POST', url: `/api/invites/${inv.json().standing.code}/accept`, headers: { cookie: c } });
    const lg = await app.inject({ method: 'POST', url: `/api/groups/${g.json().group.id}/leagues`, headers: { cookie: alice }, payload: { name: 'L' } });
    const leagueId = lg.json().league.id;
    for (const c of [bob, cara]) await app.inject({ method: 'POST', url: `/api/leagues/${leagueId}/join`, headers: { cookie: c } });

    const now = Date.now();
    const r = await app.inject({
      method: 'POST', url: `/api/leagues/${leagueId}/rounds`, headers: { cookie: alice },
      payload: { promptTitle: 'p', submitOpenAt: now - 1000, submitCloseAt: now + HOUR, voteCloseAt: now + 90 * 60_000 },
    });
    const roundId = r.json().rounds[0].id;
    for (const [c, ext] of [[alice, '1'], [bob, '2'], [cara, '3']] as const) {
      await app.inject({ method: 'PUT', url: `/api/rounds/${roundId}/submission`, headers: { cookie: c }, payload: { item: { providerType: 'tmdb', externalId: ext, title: ext } } });
    }
    await app.inject({ method: 'POST', url: `/api/rounds/${roundId}/advance`, headers: { cookie: alice } });

    // alice votes; bob and cara don't
    const ballot = await app.inject({ method: 'GET', url: `/api/rounds/${roundId}/ballot`, headers: { cookie: alice } });
    await app.inject({
      method: 'PUT', url: `/api/rounds/${roundId}/ballot`, headers: { cookie: alice },
      payload: { allocations: [{ submissionId: ballot.json().items[0].id, points: 6 }, { submissionId: ballot.json().items[1].id, points: 4 }] },
    });

    sendClosingReminders(db, now);
    expect(unreadOf(1, 'voting.closing')).toBe(0); // voted
    expect(unreadOf(2, 'voting.closing')).toBe(1);
    expect(unreadOf(3, 'voting.closing')).toBe(1);
  });
});
