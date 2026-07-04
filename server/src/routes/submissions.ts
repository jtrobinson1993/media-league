import type { FastifyInstance } from 'fastify';
import type { MediaType } from '@media-league/shared';
import { requireUser } from '../app.js';
import { leagueRole, httpError } from '../lib/permissions.js';
import { getLeague } from './leagues.js';
import { getRound } from '../lib/roundLifecycle.js';
import { cachedSearch } from '../lib/media.js';

interface SubmissionRow {
  id: number;
  round_id: number;
  user_id: number;
  provider_type: string | null;
  external_id: string | null;
  title: string;
  subtitle: string | null;
  year: number | null;
  image_url: string | null;
}

function itemJson(s: SubmissionRow): Record<string, unknown> {
  return {
    id: s.id,
    providerType: s.provider_type,
    externalId: s.external_id,
    title: s.title,
    subtitle: s.subtitle,
    year: s.year,
    imageUrl: s.image_url,
    isFreeText: s.provider_type === null,
  };
}

export function registerSubmissionRoutes(app: FastifyInstance): void {
  const { db, media } = app.ctx;

  // Provider search for the league's media type (SPEC §16 submit flow).
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>(
    '/api/leagues/:id/search',
    async (req, reply) => {
      const user = requireUser(req);
      const league = getLeague(db, Number(req.params.id));
      if (!league) throw httpError(404, 'league not found');
      if (!leagueRole(db, league.id, user.id)) throw httpError(403, 'league member required');

      const q = req.query.q?.trim();
      if (!q) return { items: [] };
      const provider = media[league.media_type as MediaType];
      if (!provider) return reply.code(503).send({ error: 'search unavailable — use free text', items: [] });
      try {
        return { items: await cachedSearch(db, provider, q) };
      } catch {
        // Provider down ⇒ client falls back to free text (SPEC §11).
        return reply.code(503).send({ error: 'search unavailable — use free text', items: [] });
      }
    },
  );

  // Create or replace your submission while the window is open.
  app.put<{
    Params: { id: string };
    Body: {
      item?: { providerType?: string; externalId?: string; title?: string; subtitle?: string | null; year?: number | null; imageUrl?: string | null };
      freeText?: string;
    };
  }>('/api/rounds/:id/submission', async (req, reply) => {
    const user = requireUser(req);
    const round = getRound(db, Number(req.params.id));
    if (!round) throw httpError(404, 'round not found');
    if (!leagueRole(db, round.league_id, user.id)) throw httpError(403, 'league member required');
    if (round.phase !== 'submitting') return reply.code(400).send({ error: 'submissions are not open' });

    const league = getLeague(db, round.league_id)!;
    const b = req.body ?? {};

    let fields: { providerType: string | null; externalId: string | null; title: string; subtitle: string | null; year: number | null; imageUrl: string | null };
    if (b.item) {
      const { providerType, externalId, title } = b.item;
      if (!providerType || !externalId || !title?.trim()) {
        return reply.code(400).send({ error: 'item needs providerType, externalId, title' });
      }
      fields = {
        providerType,
        externalId,
        title: title.trim(),
        subtitle: b.item.subtitle?.toString().trim() || null,
        year: typeof b.item.year === 'number' ? b.item.year : null,
        imageUrl: b.item.imageUrl?.toString() || null,
      };
    } else if (typeof b.freeText === 'string' && b.freeText.trim()) {
      if (b.freeText.trim().length > 200) return reply.code(400).send({ error: 'freeText max 200 chars' });
      fields = { providerType: null, externalId: null, title: b.freeText.trim(), subtitle: null, year: null, imageUrl: null };
    } else {
      return reply.code(400).send({ error: 'provide item or freeText' });
    }

    // Duplicate rule (SPEC §11): when duplicates are off, a provider item may
    // be used once per round. The rejection is anonymous. Free text is exempt.
    if (!league.allow_duplicates && fields.providerType) {
      const dupe = db
        .prepare(
          'SELECT 1 FROM submissions WHERE round_id = ? AND provider_type = ? AND external_id = ? AND user_id != ?',
        )
        .get(round.id, fields.providerType, fields.externalId, user.id);
      if (dupe) {
        return reply.code(409).send({ error: 'already submitted this round — choose a different one' });
      }
    }

    const now = Date.now();
    db.prepare(
      `INSERT INTO submissions (round_id, user_id, provider_type, external_id, title, subtitle, year, image_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (round_id, user_id) DO UPDATE SET
         provider_type = excluded.provider_type, external_id = excluded.external_id,
         title = excluded.title, subtitle = excluded.subtitle, year = excluded.year,
         image_url = excluded.image_url, updated_at = excluded.updated_at`,
    ).run(round.id, user.id, fields.providerType, fields.externalId, fields.title, fields.subtitle, fields.year, fields.imageUrl, now, now);

    const mine = db
      .prepare('SELECT * FROM submissions WHERE round_id = ? AND user_id = ?')
      .get(round.id, user.id) as SubmissionRow;
    return { submission: itemJson(mine) };
  });

  app.delete<{ Params: { id: string } }>('/api/rounds/:id/submission', async (req, reply) => {
    const user = requireUser(req);
    const round = getRound(db, Number(req.params.id));
    if (!round) throw httpError(404, 'round not found');
    if (round.phase !== 'submitting') return reply.code(400).send({ error: 'submissions are not open' });
    const info = db.prepare('DELETE FROM submissions WHERE round_id = ? AND user_id = ?').run(round.id, user.id);
    if (info.changes === 0) return reply.code(404).send({ error: 'no submission' });
    return { ok: true };
  });

  // Phase-aware listing (SPEC §11 anonymity):
  //  - submitting: only your own pick
  //  - voting:     all items, anonymous, duplicates merged, stable random order
  //  - finished:   full attribution (authors revealed)
  app.get<{ Params: { id: string } }>('/api/rounds/:id/submissions', async (req) => {
    const user = requireUser(req);
    const round = getRound(db, Number(req.params.id));
    if (!round) throw httpError(404, 'round not found');
    if (!leagueRole(db, round.league_id, user.id)) throw httpError(403, 'league member required');

    const all = db
      .prepare('SELECT * FROM submissions WHERE round_id = ? ORDER BY id')
      .all(round.id) as SubmissionRow[];

    if (round.phase === 'scheduled' || round.phase === 'submitting') {
      const mine = all.find((s) => s.user_id === user.id);
      return { phase: round.phase, mine: mine ? itemJson(mine) : null };
    }

    if (round.phase === 'voting') {
      // Merge duplicate provider items into one anonymous ballot entry
      // (SPEC §11 duplicates-on). Ballot ids are the lowest submission id of
      // the merged set so votes have a stable target.
      const merged = new Map<string, SubmissionRow & { submitterIds: number[] }>();
      for (const s of all) {
        const key = s.provider_type ? `${s.provider_type}:${s.external_id}` : `sub:${s.id}`;
        const existing = merged.get(key);
        if (existing) existing.submitterIds.push(s.user_id);
        else merged.set(key, { ...s, submitterIds: [s.user_id] });
      }
      const items = [...merged.values()]
        // Deterministic shuffle keyed by round id, unlinked from insert order.
        .sort((a, b) => ((a.id * 2654435761) % 97) - ((b.id * 2654435761) % 97) || a.id - b.id)
        .map((s) => ({
          ...itemJson(s),
          mine: s.submitterIds.includes(user.id),
        }));
      return { phase: round.phase, items };
    }

    // finished / voided: reveal authorship
    const users = db
      .prepare(
        `SELECT u.id, u.username, u.display_name AS displayName FROM users u
         WHERE u.id IN (SELECT user_id FROM submissions WHERE round_id = ?)`,
      )
      .all(round.id) as { id: number; username: string; displayName: string | null }[];
    const byId = new Map(users.map((u) => [u.id, u]));
    return {
      phase: round.phase,
      items: all.map((s) => ({ ...itemJson(s), submitter: byId.get(s.user_id) ?? null })),
    };
  });
}
