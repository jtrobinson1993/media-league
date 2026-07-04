import { randomBytes } from 'node:crypto';
import type { DB } from '../db.js';

export const SESSION_COOKIE = 'ml_session';

export interface SessionUser {
  id: number;
  username: string;
  displayName: string | null;
  isOperator: boolean;
  suspended: boolean;
}

export function createSession(db: DB, userId: number, ttlDays: number): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = now + ttlDays * 86_400_000;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
    token,
    userId,
    expiresAt,
    now,
  );
  return { token, expiresAt };
}

export function getSessionUser(db: DB, token: string): SessionUser | null {
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.is_operator, u.suspended
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`,
    )
    .get(token, Date.now()) as
    | { id: number; username: string; display_name: string | null; is_operator: number; suspended: number }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isOperator: row.is_operator === 1,
    suspended: row.suspended === 1,
  };
}

export function deleteSession(db: DB, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function deleteUserSessions(db: DB, userId: number): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}
