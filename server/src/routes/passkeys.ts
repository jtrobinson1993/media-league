import type { FastifyInstance } from 'fastify';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { SESSION_COOKIE, createSession } from '../auth/sessions.js';
import { requireUser } from '../app.js';

interface PendingChallenge {
  challenge: string;
  userId: number | null; // null for usernameless login
  expiresAt: number;
}

// Challenges are short-lived and single-use; an in-memory map is fine for a
// single-process server (SPEC: one always-on container).
const pending = new Map<string, PendingChallenge>();
const CHALLENGE_TTL_MS = 5 * 60_000;

function putChallenge(key: string, challenge: string, userId: number | null): void {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
  pending.set(key, { challenge, userId, expiresAt: now + CHALLENGE_TTL_MS });
}

function takeChallenge(key: string): PendingChallenge | null {
  const entry = pending.get(key);
  pending.delete(key);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry;
}

interface CredentialRow {
  id: string;
  user_id: number;
  public_key: Buffer;
  counter: number;
  transports: string | null;
}

export function registerPasskeyRoutes(app: FastifyInstance): void {
  const { db, config } = app.ctx;
  const rpID = new URL(config.appOrigin).hostname;
  const expectedOrigin = config.appOrigin;
  const secure = config.appOrigin.startsWith('https://');

  app.post('/api/auth/passkeys/register-options', async (req) => {
    const user = requireUser(req);
    const existing = db
      .prepare('SELECT id, transports FROM credentials WHERE user_id = ?')
      .all(user.id) as Pick<CredentialRow, 'id' | 'transports'>[];

    const options = await generateRegistrationOptions({
      rpName: 'Media League',
      rpID,
      userName: user.username,
      userID: new TextEncoder().encode(String(user.id)),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({
        id: c.id,
        transports: c.transports ? (JSON.parse(c.transports) as AuthenticatorTransportFuture[]) : undefined,
      })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    putChallenge(`reg:${user.id}`, options.challenge, user.id);
    return options;
  });

  app.post<{ Body: Record<string, unknown> }>('/api/auth/passkeys/register-verify', async (req, reply) => {
    const user = requireUser(req);
    const entry = takeChallenge(`reg:${user.id}`);
    if (!entry) return reply.code(400).send({ error: 'no pending registration' });

    try {
      const verification = await verifyRegistrationResponse({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        response: req.body as any,
        expectedChallenge: entry.challenge,
        expectedOrigin,
        expectedRPID: rpID,
      });
      if (!verification.verified || !verification.registrationInfo) {
        return reply.code(400).send({ error: 'passkey verification failed' });
      }
      const { credential } = verification.registrationInfo;
      db.prepare(
        'INSERT INTO credentials (id, user_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        credential.id,
        user.id,
        Buffer.from(credential.publicKey),
        credential.counter,
        JSON.stringify(credential.transports ?? []),
        Date.now(),
      );
      return { ok: true };
    } catch {
      return reply.code(400).send({ error: 'passkey verification failed' });
    }
  });

  app.get('/api/auth/passkeys', async (req) => {
    const user = requireUser(req);
    const rows = db
      .prepare('SELECT id, created_at FROM credentials WHERE user_id = ?')
      .all(user.id) as { id: string; created_at: number }[];
    return { passkeys: rows.map((r) => ({ id: r.id, createdAt: r.created_at })) };
  });

  app.delete<{ Params: { id: string } }>('/api/auth/passkeys/:id', async (req, reply) => {
    const user = requireUser(req);
    const info = db
      .prepare('DELETE FROM credentials WHERE id = ? AND user_id = ?')
      .run(req.params.id, user.id);
    if (info.changes === 0) return reply.code(404).send({ error: 'passkey not found' });
    return { ok: true };
  });

  app.post<{ Body: { username?: string } }>(
    '/api/auth/passkeys/login-options',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      let allowCredentials: { id: string; transports?: AuthenticatorTransportFuture[] }[] | undefined;
      let userId: number | null = null;

      if (req.body?.username) {
        const user = db
          .prepare('SELECT id FROM users WHERE username = ? AND suspended = 0')
          .get(req.body.username) as { id: number } | undefined;
        // Don't reveal whether the username exists; fall through to discoverable.
        if (user) {
          userId = user.id;
          const creds = db
            .prepare('SELECT id, transports FROM credentials WHERE user_id = ?')
            .all(user.id) as Pick<CredentialRow, 'id' | 'transports'>[];
          allowCredentials = creds.map((c) => ({
            id: c.id,
            transports: c.transports ? (JSON.parse(c.transports) as AuthenticatorTransportFuture[]) : undefined,
          }));
        }
      }

      const options = await generateAuthenticationOptions({
        rpID,
        userVerification: 'preferred',
        allowCredentials,
      });
      const key = `auth:${options.challenge}`;
      putChallenge(key, options.challenge, userId);
      reply.header('x-challenge-key', key);
      return options;
    },
  );

  app.post<{ Body: { challengeKey?: string; response?: Record<string, unknown> } }>(
    '/api/auth/passkeys/login-verify',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { challengeKey, response } = req.body ?? {};
      if (!challengeKey || !response) return reply.code(400).send({ error: 'missing fields' });
      const entry = takeChallenge(challengeKey);
      if (!entry) return reply.code(400).send({ error: 'challenge expired' });

      const credId = (response as { id?: string }).id;
      const cred = db
        .prepare('SELECT id, user_id, public_key, counter, transports FROM credentials WHERE id = ?')
        .get(credId ?? '') as CredentialRow | undefined;
      if (!cred) return reply.code(401).send({ error: 'unknown passkey' });
      if (entry.userId !== null && entry.userId !== cred.user_id) {
        return reply.code(401).send({ error: 'passkey does not match user' });
      }

      try {
        const verification = await verifyAuthenticationResponse({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          response: response as any,
          expectedChallenge: entry.challenge,
          expectedOrigin,
          expectedRPID: rpID,
          credential: {
            id: cred.id,
            publicKey: new Uint8Array(cred.public_key),
            counter: cred.counter,
            transports: cred.transports
              ? (JSON.parse(cred.transports) as AuthenticatorTransportFuture[])
              : undefined,
          },
        });
        if (!verification.verified) return reply.code(401).send({ error: 'verification failed' });

        db.prepare('UPDATE credentials SET counter = ? WHERE id = ?').run(
          verification.authenticationInfo.newCounter,
          cred.id,
        );
        const suspended = db.prepare('SELECT suspended FROM users WHERE id = ?').get(cred.user_id) as {
          suspended: number;
        };
        if (suspended.suspended) return reply.code(403).send({ error: 'account suspended' });

        const session = createSession(db, cred.user_id, config.sessionTtlDays);
        reply.setCookie(SESSION_COOKIE, session.token, {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          secure,
          maxAge: config.sessionTtlDays * 86_400,
        });
        return { ok: true };
      } catch {
        return reply.code(401).send({ error: 'verification failed' });
      }
    },
  );
}
