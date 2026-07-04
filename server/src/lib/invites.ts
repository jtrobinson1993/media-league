import { randomBytes } from 'node:crypto';
import type { DB } from '../db.js';
import type { InviteKind, InviteScope } from '@media-league/shared';

export interface InviteRow {
  id: number;
  scope: InviteScope;
  target_id: number;
  code: string;
  kind: InviteKind;
  expires_at: number | null;
  max_uses: number | null;
  uses: number;
  revoked: number;
}

function newCode(): string {
  return randomBytes(6).toString('base64url');
}

export function createInvite(
  db: DB,
  scope: InviteScope,
  targetId: number,
  kind: InviteKind,
  createdBy: number,
  opts: { ttlHours?: number; maxUses?: number } = {},
): InviteRow {
  const code = newCode();
  const expiresAt = kind === 'one-time' && opts.ttlHours ? Date.now() + opts.ttlHours * 3_600_000 : null;
  db.prepare(
    `INSERT INTO invites (scope, target_id, code, kind, expires_at, max_uses, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(scope, targetId, code, kind, expiresAt, kind === 'one-time' ? (opts.maxUses ?? 1) : null, createdBy, Date.now());
  return getInviteByCode(db, code)!;
}

export function getInviteByCode(db: DB, code: string): InviteRow | null {
  return (db.prepare('SELECT * FROM invites WHERE code = ?').get(code) as InviteRow | undefined) ?? null;
}

export function standingInvite(db: DB, scope: InviteScope, targetId: number): InviteRow | null {
  return (
    (db
      .prepare(
        "SELECT * FROM invites WHERE scope = ? AND target_id = ? AND kind = 'standing' AND revoked = 0",
      )
      .get(scope, targetId) as InviteRow | undefined) ?? null
  );
}

/** Regenerate the standing invite: revoke the old one, mint a new code. */
export function regenerateStandingInvite(db: DB, scope: InviteScope, targetId: number, byUser: number): InviteRow {
  db.prepare("UPDATE invites SET revoked = 1 WHERE scope = ? AND target_id = ? AND kind = 'standing'").run(
    scope,
    targetId,
  );
  return createInvite(db, scope, targetId, 'standing', byUser);
}

export type InviteValidity = 'ok' | 'revoked' | 'expired' | 'exhausted' | 'not-found';

export function inviteValidity(invite: InviteRow | null): InviteValidity {
  if (!invite) return 'not-found';
  if (invite.revoked) return 'revoked';
  if (invite.expires_at !== null && invite.expires_at < Date.now()) return 'expired';
  if (invite.max_uses !== null && invite.uses >= invite.max_uses) return 'exhausted';
  return 'ok';
}

export function consumeInvite(db: DB, invite: InviteRow): void {
  db.prepare('UPDATE invites SET uses = uses + 1 WHERE id = ?').run(invite.id);
}
