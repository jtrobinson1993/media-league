import webpush from 'web-push';
import type { NotificationType } from '@media-league/shared';
import type { DB } from '../db.js';
import type { Config } from '../config.js';

let pushConfigured = false;

export function configurePush(config: Config): void {
  if (config.vapidPublicKey && config.vapidPrivateKey) {
    webpush.setVapidDetails(config.appOrigin, config.vapidPublicKey, config.vapidPrivateKey);
    pushConfigured = true;
  } else {
    pushConfigured = false;
  }
}

export interface NotifyPayload {
  title: string;
  body?: string;
  leagueId?: number;
  roundId?: number;
  [key: string]: unknown;
}

/** Insert in-app notifications and fire web push (best-effort, async). */
export function notify(db: DB, userIds: number[], type: NotificationType, payload: NotifyPayload): void {
  if (userIds.length === 0) return;
  const now = Date.now();
  const insert = db.prepare(
    'INSERT INTO notifications (user_id, type, payload, read, created_at) VALUES (?, ?, ?, 0, ?)',
  );
  const txn = db.transaction(() => {
    for (const id of userIds) insert.run(id, type, JSON.stringify(payload), now);
  });
  txn();

  if (!pushConfigured) return;
  const subs = db
    .prepare(
      `SELECT user_id, endpoint, keys FROM push_subscriptions WHERE user_id IN (${userIds.map(() => '?').join(',')})`,
    )
    .all(...userIds) as { user_id: number; endpoint: string; keys: string }[];
  const message = JSON.stringify({ type, ...payload });
  for (const sub of subs) {
    void webpush
      .sendNotification({ endpoint: sub.endpoint, keys: JSON.parse(sub.keys) }, message)
      .catch((err: { statusCode?: number }) => {
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
        }
      });
  }
}

/** Active league member ids (notification audience). */
export function leagueMemberIds(db: DB, leagueId: number): number[] {
  return (
    db
      .prepare("SELECT user_id FROM league_members WHERE league_id = ? AND status = 'active'")
      .all(leagueId) as { user_id: number }[]
  ).map((r) => r.user_id);
}
