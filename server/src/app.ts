import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { Config } from './config.js';
import type { DB } from './db.js';

export interface AppContext {
  config: Config;
  db: DB;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

/** Build the Fastify app (no listen) — used by index.ts and tests. */
export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  app.decorate('ctx', ctx);

  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  app.get('/api/health', async () => ({ ok: true }));

  return app;
}
