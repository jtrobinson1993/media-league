import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { SESSION_COOKIE, getSessionUser, type SessionUser } from './auth/sessions.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerPasskeyRoutes } from './routes/passkeys.js';
import { registerGroupRoutes } from './routes/groups.js';
import { registerLeagueRoutes } from './routes/leagues.js';
import { registerRoundRoutes } from './routes/rounds.js';
import { registerSubmissionRoutes } from './routes/submissions.js';
import { defaultRegistry, type MediaRegistry } from './lib/media.js';
import { registerVoteRoutes } from './routes/votes.js';
import { setFinalizeHook } from './lib/roundLifecycle.js';
import { finalizeRound } from './lib/scoring.js';

export interface AppContext {
  config: Config;
  db: DB;
  /** Media providers by league mediaType; defaults from config (TMDB). */
  media?: MediaRegistry;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext & { media: MediaRegistry };
  }
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

/** Build the Fastify app (no listen) — used by index.ts and tests. */
export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  app.decorate('ctx', { ...ctx, media: ctx.media ?? defaultRegistry(ctx.config) });
  app.decorateRequest('user', null);

  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  // Resolve the session on every request; suspended users are signed out.
  app.addHook('preHandler', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const user = getSessionUser(ctx.db, token);
    req.user = user && !user.suspended ? user : null;
  });

  app.get('/api/health', async () => ({ ok: true }));

  registerAuthRoutes(app);
  registerPasskeyRoutes(app);
  registerGroupRoutes(app);
  registerLeagueRoutes(app);
  registerRoundRoutes(app);
  registerSubmissionRoutes(app);
  registerVoteRoutes(app);

  // Scoring runs when the lifecycle finishes a round (SPEC §12/§15).
  setFinalizeHook((db, round) => finalizeRound(db, round, ctx.config.coinRewards));

  return app;
}

/** Guard helper: 401 unless signed in. */
export function requireUser(req: { user: SessionUser | null }): SessionUser {
  if (!req.user) {
    const err = new Error('not signed in') as Error & { statusCode: number };
    err.statusCode = 401;
    throw err;
  }
  return req.user;
}
