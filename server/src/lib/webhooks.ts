import type { WebhookEvent, WebhookFormat } from '@media-league/shared';
import type { DB } from '../db.js';

export interface WebhookData {
  leagueName: string;
  roundNumber?: number;
  prompt?: string | null;
  detail?: string;
  [key: string]: unknown;
}

export type WebhookTransport = (url: string, body: unknown) => Promise<void>;

let transport: WebhookTransport = async (url, body) => {
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {}); // fire-and-forget, no retries in v1
};

/** Tests replace the transport to capture deliveries. */
export function setWebhookTransport(t: WebhookTransport): void {
  transport = t;
}

function describe(event: WebhookEvent, data: WebhookData): string {
  const round = data.roundNumber ? `Round ${data.roundNumber}` : 'A round';
  const prompt = data.prompt ? ` — “${data.prompt}”` : '';
  switch (event) {
    case 'round.created':
      return `${round} was created in ${data.leagueName}${prompt}`;
    case 'submissions.open':
      return `🎬 Submissions are open for ${round} in ${data.leagueName}${prompt}`;
    case 'submissions.closed':
      return `Submissions closed for ${round} in ${data.leagueName}`;
    case 'voting.open':
      return `🗳️ Voting is open for ${round} in ${data.leagueName}${prompt}`;
    case 'voting.closed':
      return `Voting closed for ${round} in ${data.leagueName}`;
    case 'results.posted':
      return `📊 Results are up for ${round} in ${data.leagueName}${prompt}`;
    case 'winner.announced':
      return `🏆 ${data.detail ?? 'Winner announced'} — ${round} in ${data.leagueName}`;
  }
}

function formatBody(format: WebhookFormat, event: WebhookEvent, data: WebhookData): unknown {
  const text = describe(event, data);
  switch (format) {
    case 'discord':
      return { embeds: [{ title: text, color: 0xd4af37 }] };
    case 'slack':
      return { blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
    case 'generic':
      return { event, timestamp: Date.now(), text, data };
  }
}

/** Send an event to every league webhook subscribed to it (SPEC §14). */
export function dispatchWebhooks(db: DB, leagueId: number, event: WebhookEvent, data: WebhookData): void {
  const hooks = db
    .prepare('SELECT url, format, events FROM webhooks WHERE league_id = ?')
    .all(leagueId) as { url: string; format: WebhookFormat; events: string }[];
  for (const hook of hooks) {
    const events = JSON.parse(hook.events) as WebhookEvent[];
    if (!events.includes(event)) continue;
    void transport(hook.url, formatBody(hook.format, event, data));
  }
}
