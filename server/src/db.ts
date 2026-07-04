import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

// Schema versioning: each migration runs once, tracked in schema_migrations.
// v1 creates the full SPEC.md data model.
const MIGRATIONS: string[] = [
  /* v1 */ `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    display_name  TEXT,
    avatar        TEXT NOT NULL DEFAULT '{"kind":"initials","color":"auto"}', -- AvatarConfig JSON
    coins         INTEGER NOT NULL DEFAULT 0,
    equipped      TEXT NOT NULL DEFAULT '{}', -- { frame?: itemId } per cosmetic type
    is_operator   INTEGER NOT NULL DEFAULT 0,
    suspended     INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE credentials ( -- WebAuthn passkeys
    id            TEXT PRIMARY KEY,           -- base64url credential id
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key    BLOB NOT NULL,
    counter       INTEGER NOT NULL DEFAULT 0,
    transports    TEXT,                        -- JSON array
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  CREATE TABLE groups (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE group_members (
    group_id  INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
    status    TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed','left')),
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );

  CREATE TABLE leagues (
    id                        INTEGER PRIMARY KEY,
    group_id                  INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name                      TEXT NOT NULL,
    media_type                TEXT NOT NULL DEFAULT 'movie',
    visibility                TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
    allow_duplicates          INTEGER NOT NULL DEFAULT 0,
    require_submission_to_vote INTEGER NOT NULL DEFAULT 1,
    prompt_mode               TEXT NOT NULL DEFAULT 'admin' CHECK (prompt_mode IN ('admin','winner-picks-next')),
    schedule_template         TEXT,            -- ScheduleTemplate JSON, nullable
    default_voting_config     TEXT NOT NULL,   -- VotingConfig JSON
    created_by                INTEGER NOT NULL REFERENCES users(id),
    created_at                INTEGER NOT NULL
  );
  CREATE INDEX idx_leagues_group ON leagues(group_id);

  CREATE TABLE league_members (
    league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
    status    TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed','left')),
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (league_id, user_id)
  );

  CREATE TABLE rounds (
    id               INTEGER PRIMARY KEY,
    league_id        INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    number           INTEGER NOT NULL,
    prompt_title     TEXT,               -- null until set (winner-picks queueing)
    prompt_description TEXT,
    prompt_author_id INTEGER REFERENCES users(id),
    chooser_id       INTEGER REFERENCES users(id), -- winner picked to author prompt
    phase            TEXT NOT NULL DEFAULT 'scheduled'
                     CHECK (phase IN ('scheduled','submitting','voting','finished','voided')),
    submit_open_at   INTEGER NOT NULL,
    submit_close_at  INTEGER NOT NULL,
    vote_open_at     INTEGER NOT NULL,
    vote_close_at    INTEGER NOT NULL,
    voting_config    TEXT NOT NULL,      -- VotingConfig JSON
    finalized_at     INTEGER,
    UNIQUE (league_id, number)
  );
  CREATE INDEX idx_rounds_league ON rounds(league_id);
  CREATE INDEX idx_rounds_phase ON rounds(phase);

  CREATE TABLE submissions (
    id            INTEGER PRIMARY KEY,
    round_id      INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_type TEXT,                 -- null ⇒ free-text submission
    external_id   TEXT,
    title         TEXT NOT NULL,
    subtitle      TEXT,
    year          INTEGER,
    image_url     TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    UNIQUE (round_id, user_id)
  );
  CREATE INDEX idx_submissions_round ON submissions(round_id);

  CREATE TABLE votes (
    round_id      INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
    voter_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    points        INTEGER NOT NULL,     -- pool: allocated points; ranked: resolved weight
    rank          INTEGER,              -- ranked only: 1..K
    note          TEXT,
    PRIMARY KEY (round_id, voter_id, submission_id)
  );
  CREATE INDEX idx_votes_round ON votes(round_id);

  CREATE TABLE round_results ( -- materialized at finalize time
    round_id      INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
    submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    score         INTEGER NOT NULL,
    placement     INTEGER NOT NULL,     -- 1 = winner; ties share a placement
    PRIMARY KEY (round_id, submission_id)
  );

  CREATE TABLE invites (
    id         INTEGER PRIMARY KEY,
    scope      TEXT NOT NULL CHECK (scope IN ('group','league')),
    target_id  INTEGER NOT NULL,        -- group id or league id
    code       TEXT NOT NULL UNIQUE,
    kind       TEXT NOT NULL CHECK (kind IN ('standing','one-time')),
    expires_at INTEGER,                 -- one-time only
    max_uses   INTEGER,                 -- one-time only
    uses       INTEGER NOT NULL DEFAULT 0,
    revoked    INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_invites_target ON invites(scope, target_id);

  CREATE TABLE notifications (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       TEXT NOT NULL,
    payload    TEXT NOT NULL,           -- JSON
    read       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_notifications_user ON notifications(user_id, read);

  CREATE TABLE push_subscriptions (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint   TEXT NOT NULL,
    keys       TEXT NOT NULL,           -- JSON {p256dh, auth}
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, endpoint)
  );

  CREATE TABLE webhooks (
    id         INTEGER PRIMARY KEY,
    league_id  INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    url        TEXT NOT NULL,
    format     TEXT NOT NULL CHECK (format IN ('generic','discord','slack')),
    events     TEXT NOT NULL,           -- JSON array of WebhookEvent
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE coin_ledger (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    round_id   INTEGER REFERENCES rounds(id) ON DELETE SET NULL,
    amount     INTEGER NOT NULL,        -- positive = earn, negative = spend
    reason     TEXT NOT NULL,           -- 'participation' | 'podium-1' | ... | 'purchase'
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_ledger_user ON coin_ledger(user_id);

  CREATE TABLE cosmetic_items (
    id    TEXT PRIMARY KEY,             -- e.g. 'frame.gold-reel'
    type  TEXT NOT NULL DEFAULT 'frame',
    name  TEXT NOT NULL,
    price INTEGER NOT NULL,
    asset TEXT NOT NULL                 -- CSS class / asset key rendered client-side
  );

  CREATE TABLE user_inventory (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id     TEXT NOT NULL REFERENCES cosmetic_items(id) ON DELETE CASCADE,
    acquired_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, item_id)
  );

  CREATE TABLE media_cache ( -- short-lived TMDB search cache (SPEC §19)
    cache_key  TEXT PRIMARY KEY,
    payload    TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,
];

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );
  const appliedRow = db
    .prepare('SELECT MAX(version) AS v FROM schema_migrations')
    .get() as { v: number | null };
  const applied = appliedRow.v ?? 0;
  for (let i = applied; i < MIGRATIONS.length; i++) {
    const run = db.transaction(() => {
      db.exec(MIGRATIONS[i]!);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        i + 1,
        Date.now(),
      );
    });
    run();
  }
}
