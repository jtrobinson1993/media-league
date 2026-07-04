import type { DB } from '../db.js';

/** Insert or reactivate a membership (invite acceptance, rejoin). */
export function joinGroup(db: DB, groupId: number, userId: number, role: 'admin' | 'member' = 'member'): void {
  db.prepare(
    `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
     VALUES (?, ?, ?, 'active', ?)
     ON CONFLICT (group_id, user_id)
     DO UPDATE SET status = 'active', joined_at = excluded.joined_at`,
  ).run(groupId, userId, role, Date.now());
}

export function joinLeague(db: DB, leagueId: number, userId: number, role: 'admin' | 'member' = 'member'): void {
  db.prepare(
    `INSERT INTO league_members (league_id, user_id, role, status, joined_at)
     VALUES (?, ?, ?, 'active', ?)
     ON CONFLICT (league_id, user_id)
     DO UPDATE SET status = 'active', joined_at = excluded.joined_at`,
  ).run(leagueId, userId, role, Date.now());
}

/** History-preserving departure (SPEC §13): row stays, status changes. */
export function setGroupMemberStatus(db: DB, groupId: number, userId: number, status: 'removed' | 'left'): boolean {
  const info = db
    .prepare("UPDATE group_members SET status = ? WHERE group_id = ? AND user_id = ? AND status = 'active'")
    .run(status, groupId, userId);
  if (info.changes === 0) return false;
  // Cascade to the group's leagues (SPEC §13: group removal cascades).
  db.prepare(
    `UPDATE league_members SET status = ?
     WHERE user_id = ? AND status = 'active'
       AND league_id IN (SELECT id FROM leagues WHERE group_id = ?)`,
  ).run(status, userId, groupId);
  return true;
}

export function setLeagueMemberStatus(db: DB, leagueId: number, userId: number, status: 'removed' | 'left'): boolean {
  const info = db
    .prepare("UPDATE league_members SET status = ? WHERE league_id = ? AND user_id = ? AND status = 'active'")
    .run(status, leagueId, userId);
  return info.changes > 0;
}
