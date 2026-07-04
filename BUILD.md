# Media League — build checklist (v1 per SPEC.md)

Working document for the implementation loop. Check items off as they land.

## Milestone 1 — scaffold
- [x] Monorepo: root workspaces (shared/server/web), tsconfig.base, vitest
- [x] shared: core domain types (media items, voting config, round phases)
- [x] server: Fastify boot, config from env, /api/health
- [x] server: SQLite schema v1 (all tables), migration runner
- [x] web: Vite + Vue 3 + Tailwind v4 shell that builds

## Milestone 2 — auth & tenancy
- [x] Sessions (cookie), register/login/logout (username+password, scrypt)
- [x] Passkeys (SimpleWebAuthn register/login)
- [x] Groups: create, invites (standing + one-time), join, roles, co-admins
- [x] Leagues: create, visibility, rosters, co-admins, league invite links
- [x] Operator console API (reset credentials, suspend/ban, delete, stats)

## Milestone 3 — game core
- [x] Rounds: CRUD, schedule template, prompt queueing, winner-picks-next (chooser flow lands with scoring)
- [x] In-app scheduler (phase transitions, void rules)
- [x] Submissions: MediaProvider interface, TMDB provider, free-text, dupes
- [x] Voting: pool + ranked engines, validation, notes, self-vote rules
- [x] Scoring: tallies, ties/co-winners, standings (archive UI later)
- [x] Coins: ledger, participation +5, podium 30/20/10; store + frames

## Milestone 4 — notifications
- [x] In-app notification center (feed, read state, badges)
- [x] Web push (VAPID)
- [x] Outbound webhooks: generic/discord/slack, league events

## Milestone 5 — web app
- [x] Auth screens; app shell (3-tab bottom bar, light/dark)
- [x] Home (leagues+groups, action badges), group page, guided empty states
- [x] League page (timeline feed, standings tab, info)
- [x] Submit flow (search → confirm card), ballot (steppers / tap-to-rank)
- [x] Results (summary table + drill-in votes/notes)
- [x] Profile: stats, avatar (initials/gallery; upload later), store try-on grid
- [x] Admin: basic round creation + invites (full settings/webhooks UI later)
- [x] Operator console UI

## Milestone 6 — ship
- [ ] Playwright e2e happy path
- [ ] Dockerfile + docker-compose + Caddyfile + .env.example
- [ ] GitHub Actions: build + publish GHCR image
- [ ] README deploy docs
