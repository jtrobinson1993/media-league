import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { registerProfileRoutes } from './routes/profile.js';
import { registerAdminRoutes } from './routes/admin.js';
import { setFinalizeHook, setTransitionHook } from './lib/roundLifecycle.js';
import { handleTransition } from './lib/events.js';
import { configurePush } from './lib/notifications.js';
import { registerNotificationRoutes } from './routes/notifications.js';
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
  registerProfileRoutes(app);
  registerAdminRoutes(app);
  registerNotificationRoutes(app);

  // Scoring runs when the lifecycle finishes a round (SPEC §12/§15).
  setFinalizeHook((db, round) => finalizeRound(db, round, ctx.config.coinRewards));
  // Transitions fan out to in-app notifications, web push, and webhooks (SPEC §14).
  setTransitionHook(handleTransition);
  configurePush(ctx.config);

  // Production: serve the built SPA with an index.html fallback for routes.
  const webDist = resolve(import.meta.dirname, '../../web/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  }

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
