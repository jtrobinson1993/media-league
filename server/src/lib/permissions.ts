import type { DB } from '../db.js';
import type { GroupRole } from '@media-league/shared';

export function groupRole(db: DB, groupId: number, userId: number): GroupRole | null {
  const row = db
    .prepare("SELECT role FROM group_members WHERE group_id = ? AND user_id = ? AND status = 'active'")
    .get(groupId, userId) as { role: GroupRole } | undefined;
  return row?.role ?? null;
}

export function leagueRole(db: DB, leagueId: number, userId: number): GroupRole | null {
  const row = db
    .prepare("SELECT role FROM league_members WHERE league_id = ? AND user_id = ? AND status = 'active'")
    .get(leagueId, userId) as { role: GroupRole } | undefined;
  return row?.role ?? null;
}

export function httpError(statusCode: number, message: string): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

export function requireGroupAdmin(db: DB, groupId: number, userId: number): void {
  if (groupRole(db, groupId, userId) !== 'admin') throw httpError(403, 'group admin required');
}

export function requireGroupMember(db: DB, groupId: number, userId: number): void {
  if (!groupRole(db, groupId, userId)) throw httpError(403, 'group member required');
}
