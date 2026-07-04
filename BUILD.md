# Media League — build checklist (v1 per SPEC.md)

Working document for the implementation loop. Check items off as they land.

## Milestone 1 — scaffold
- [x] Monorepo: root workspaces (shared/server/web), tsconfig.base, vitest
- [x] shared: core domain types (media items, voting config, round phases)
- [x] server: Fastify boot, config from env, /api/health
- [x] server: SQLite schema v1 (all tables), migration runner
- [x] web: Vite + Vue 3 + Tailwind v4 shell that builds

## Milestone 2 — auth & tenancy
- [ ] Sessions (cookie), register/login/logout (username+password, argon2/scrypt)
- [ ] Passkeys (SimpleWebAuthn register/login)
- [ ] Groups: create, invites (standing + one-time), join, roles, co-admins
- [ ] Leagues: create, visibility, rosters, co-admins, league invite links
- [ ] Operator console API (reset credentials, suspend/ban, delete, stats)

## Milestone 3 — game core
- [ ] Rounds: CRUD, schedule template, prompt queueing, winner-picks-next
- [ ] In-app scheduler (phase transitions, void rules)
- [ ] Submissions: MediaProvider interface, TMDB provider, free-text, dupes
- [ ] Voting: pool + ranked engines, validation, notes, self-vote rules
- [ ] Scoring: tallies, ties/co-winners, standings, round archive
- [ ] Coins: ledger, participation +5, podium 30/20/10; store + frames

## Milestone 4 — notifications
- [ ] In-app notification center (feed, read state, badges)
- [ ] Web push (VAPID)
- [ ] Outbound webhooks: generic/discord/slack, league events

## Milestone 5 — web app
- [ ] Auth screens; app shell (3-tab bottom bar, light/dark)
- [ ] Home (leagues+groups, action badges), group page, guided empty states
- [ ] League page (timeline feed, standings tab, info)
- [ ] Submit flow (search → confirm card), ballot (steppers / tap-to-rank)
- [ ] Results (summary table + drill-in votes/notes)
- [ ] Profile: stats, avatar (initials/gallery/upload), store try-on grid
- [ ] Admin: league settings, round scheduling form, invites, webhooks
- [ ] Operator console UI

## Milestone 6 — ship
- [ ] Playwright e2e happy path
- [ ] Dockerfile + docker-compose + Caddyfile + .env.example
- [ ] GitHub Actions: build + publish GHCR image
- [ ] README deploy docs
