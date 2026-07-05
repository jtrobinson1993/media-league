import { test, expect, request, type APIRequestContext } from '@playwright/test';

/**
 * Full happy path through the real app (SPEC §10-§12, §16):
 * alice registers and builds a league in the UI; bob & cara join and play via
 * the API; alice submits, votes, advances, and reads results in the UI.
 */

async function apiUser(baseURL: string, username: string): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL });
  const res = await ctx.post('/api/auth/register', { data: { username, password: 'password1' } });
  expect(res.ok()).toBeTruthy();
  return ctx;
}

test('register → group → league → round → submit → vote → results', async ({ page, baseURL }) => {
  // --- register alice through the UI (recovery notice shows, then continues)
  await page.goto('/login');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByPlaceholder('username').fill('alice');
  await page.getByPlaceholder('password').fill('password1');
  await page.locator('button[type=submit]').click();
  await expect(page.getByText(/no password reset/i)).toBeVisible();
  await page.waitForURL('**/', { timeout: 10_000 });

  // --- guided empty state → create a group
  await expect(page.getByText('Welcome! No leagues yet.')).toBeVisible();
  await page.getByPlaceholder('Group name').fill('Friday Film Club');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByText('Friday Film Club').click();

  // --- create a league in the group
  await page.getByRole('button', { name: '+ New league' }).click();
  await page.getByPlaceholder(/League name/).fill('E2E Movie League');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByText('E2E Movie League').click();

  // --- admin checklist empty state, then add a round (opens immediately)
  await expect(page.getByText('Get your league going:')).toBeVisible();
  await page.getByRole('button', { name: '+ Add round' }).click();
  await page.getByPlaceholder(/Prompt \(e\.g\./).fill('favorite indie horror');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('Submissions open')).toBeVisible();

  // --- bob & cara join via the league's standing invite and submit (API)
  const leagueId = 1;
  const inviteRes = await page.request.get(`/api/leagues/${leagueId}/invites`);
  const code = (await inviteRes.json()).standing.code as string;
  const bob = await apiUser(baseURL!, 'bob');
  const cara = await apiUser(baseURL!, 'cara');
  for (const [ctx, ext, title] of [
    [bob, '310131', 'The Witch'],
    [cara, '270303', 'It Follows'],
  ] as const) {
    expect((await ctx.post(`/api/invites/${code}/accept`)).ok()).toBeTruthy();
    const sub = await ctx.put('/api/rounds/1/submission', {
      data: { item: { providerType: 'tmdb', externalId: ext, title, year: 2015 } },
    });
    expect(sub.ok()).toBeTruthy();
  }

  // --- alice submits through the UI via free text (no TMDB key in e2e)
  await page.getByText('favorite indie horror').click();
  await page.getByText("Can't find it?").click();
  await page.getByPlaceholder('Type the title exactly').fill('Hereditary (2018)');
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByText('✓ Your pick')).toBeVisible();

  // --- admin advances to voting; alice votes with steppers + a note
  await page.getByRole('button', { name: /Advance phase now/ }).click();
  await expect(page.getByText(/Voting closes/)).toBeVisible();
  const plus = page.getByRole('button', { name: '+', exact: true });
  await plus.first().click(); // 1 pt on first item
  for (let i = 0; i < 9; i++) await plus.last().click(); // 9 pts on the other
  await expect(page.getByText('10/10 points spent')).toBeVisible();
  await page.getByPlaceholder(/add a note/).first().fill('watched this on my birthday!');
  await page.getByRole('button', { name: 'Save ballot' }).click();
  await expect(page.getByText(/Ballot saved/)).toBeVisible();

  // --- bob & cara vote via API (ballot targets exclude own film)
  for (const ctx of [bob, cara]) {
    const ballot = await (await ctx.get('/api/rounds/1/ballot')).json();
    const items = ballot.items as { id: number }[];
    const res = await ctx.put('/api/rounds/1/ballot', {
      data: { allocations: [{ submissionId: items[0].id, points: 6 }, { submissionId: items[1].id, points: 4 }] },
    });
    expect(res.ok()).toBeTruthy();
  }

  // --- advance to results; verify reveal: winner, attribution, note
  await page.getByRole('button', { name: /Advance phase now/ }).click();
  await expect(page.getByText('🏆')).toBeVisible();
  await expect(page.getByText('alice', { exact: false }).first()).toBeVisible();

  // drill into the top film: per-voter breakdown appears
  await page.locator('button').filter({ hasText: '🏆' }).first().click();
  await expect(page.getByText(/\+\d/).first()).toBeVisible();

  // --- standings tab shows all three players
  await page.getByText('← League').click();
  await page.getByRole('button', { name: 'standings' }).click();
  for (const name of ['alice', 'bob', 'cara']) {
    await expect(page.getByText(name, { exact: false }).first()).toBeVisible();
  }
});
