# Media League — Design Spec

> **Naming:** the product is **Media League** (movies are the first media type;
> music and others come later). Repo: `jtrobinson1993/media-league`.

Status: **design agreed, pre-implementation.** This document captures the
decisions made while stress-testing the concept. It is the source of truth for
what we're building; the README is the friendly summary.

> **v1 scope note:** We deliberately chose a **feature-complete v1** — every
> feature below is in the first release, nothing deferred. This is an ambitious
> first build; if it needs to be broken into phases later, the natural cut lines
> are called out in [§17](#17-scope--phasing).

---

## 1. Concept

A Music League–style party game for **media** — **movies first**, with music and
other media types planned. Players in a league are given a themed **prompt**
(e.g. _"favorite indie horror"_), each secretly submits one item that fits (a
film in a movie league), everyone votes anonymously, points are tallied, a round
winner is crowned, and points accumulate into league standings. The UI should
feel **game-like**: fluid, animated, and celebratory (win effects, an animated
randomizer for tie-breaks).

**Multi-media generalization (v1 builds the seam, ships movies only):**
- Each **league has a `mediaType`** (v1: `movie` is the only value).
- Submissions go through a **`MediaProvider` interface**: `search(query)` →
  canonical items of shape `{ providerType, externalId, title, subtitle, year,
  imageUrl }`, plus the free-text fallback. Only the **TMDB movie provider** is
  implemented in v1; adding music later = a new provider with **no schema churn**.

---

## 2. Product framing

- **Easy-to-deploy hosted app**, operated by a single operator (you). *Not*
  positioned as "self-hostable for strangers" — but **ease of deploy is a
  first-class design constraint** (the operator is not a devops specialist).
- One deployment is **multi-tenant**: it hosts many isolated groups.

---

## 3. Architecture & deployment

Mirrors the operator's proven `notes` app deployment, which they already run
comfortably:

- **Docker Compose** with two services: the app (Node, `:3000`) and **Caddy**
  (auto HTTPS via Let's Encrypt, reverse-proxy). Only Caddy is internet-facing.
- **Prebuilt image published to GHCR** via **GitHub Actions**; the server never
  compiles. Release = `docker compose pull && up -d`.
- **SQLite** stored in a **Docker volume** holds all state; backup = copy the
  volume.
- Config via **`.env`**, with **`APP_ORIGIN`** the canonical public URL. Caddy
  provisions the cert for it and **passkeys bind to it** (choose the hostname
  before anyone registers).
- **Always-on container** runs an **in-app scheduler** (no external cron).
- Deploy is: `git clone` → set `APP_ORIGIN` → `docker compose up -d`.

## 4. Tech stack

npm-workspaces **monorepo** (`shared` / `server` / `web`), TypeScript, ESM,
Node ≥22. Mirrors `notes`.

- **Server:** **Fastify 5** + `@fastify/cookie` (sessions), `@fastify/static`
  (serves built web), `@fastify/rate-limit`; **better-sqlite3**;
  **`@simplewebauthn/server`** for passkeys.
- **Web:** **Vue 3** + **Vite** + **Pinia** (+ pinia/colada) + **vue-router** +
  **Tailwind v4** + **reka-ui**; **`@simplewebauthn/browser`**. Built as a
  **client-side SPA** that talks to the Fastify JSON API (no meta-framework).
- **Animations — initial implementation constraint:** the first implementation
  ships **plain CSS animations/transitions only** and **adds no motion/animation
  libraries**. `@vueuse/motion` / motion-v + GSAP remain **recommendations in
  this spec** for later, but are deliberately **out of the initial build** — the
  operator will design the game-feel animations themselves. Wherever this spec
  refers to an "animated" moment (winner reveal, the random-picker wheel/plinko),
  build it with a simple, easily-replaceable CSS effect as a placeholder, not a
  library-driven one.
- **Tests:** vitest + playwright.
- **Real-time:** **none** — clients use **lightweight polling**. WebSockets were
  considered and rejected for v1; the results reveal + winner randomizer play
  **async per-viewer**, not as a synchronized live "watch party" (a WS watch-party
  mode is a possible future addition).

---

## 5. Tenancy & identity

- **Full multi-tenant:** one instance hosts many **isolated groups**.
- **Global user accounts** + a **membership** table linking a user to each
  group they belong to, carrying a **role**. One login; a group switcher
  in the UI. All tenant-scoped queries filter by `(user, group)`.

## 6. Authentication & recovery

- **Identifier: username.** **Auth: username + password**, with **optional
  passkey (WebAuthn)** as an add-on. No email is stored; **no SMTP anywhere**.
  - *Constraint:* passkeys require a configured public origin/RP-ID + HTTPS
    (satisfied by `APP_ORIGIN` + Caddy).
- **Recovery: server-admin (operator) manual only.** No self-service reset, no
  recovery codes, no email. This is **not surfaced as a user feature**; users are
  told at signup to keep their credentials safe.

## 7. Onboarding & invites

- **Self-serve:** any registered user can **create a group** and becomes its
  **group admin**. Others join via a **shareable invite link / join code**.
- The instance is open to sign-ups (an operator-level gate on registration is a
  possible future knob, not in scope now).

---

## 8. Domain hierarchy

```
Group → League → Round
```

No "season" layer — if someone wants seasons, they put it in the league name.
Standings are **per-league**, summed across that league's rounds. League **names
are freeform** and typically encode the group + media (e.g. "Movie Snob Movie
League", "Joe's Music League"). Each league carries a **`mediaType`** (v1:
`movie`).

**Navigation model:** a user's **homepage** lists their active **leagues** and
**groups**; each **group page** lists that group's available
leagues.

## 9. Leagues

- **Opt-in participation with per-league rosters** (`league_members`). A
  group can run **multiple concurrent leagues** with different participants.
- **Visibility (per league):** `public` (listed in the group's league
  directory, any member can join) or `private` (unlisted, join only via invite).
- **League invite links onboard outsiders:** following a league link joins a
  non-member to the **group *and* that league** in one step.
- **League creator = league admin.**
- **`promptMode` (per league):**
  - `admin` (default) — the league admin authors every prompt.
  - `winner-picks-next` — the **winner of a round chooses the next round's
    prompt**. Rules:
    - Round 1's prompt is always seeded by the admin.
    - The admin still defines each round's schedule/durations; the winner only
      supplies the **prompt text**.
    - If the chooser doesn't submit a prompt before the round's scheduled start,
      authorship **falls back to the admin** (never stalls).
    - **Co-winner tie → the chooser is picked at random**, dramatized by an
      **animated visual randomizer** (wheel spin / plinko / bingo pull). Admin
      can override the pick. (Build as a reusable "pick-one-at-random" component.)

## 10. Round lifecycle & scheduling

Phases: **prompt → submission → voting → results.**

- **Admin-scheduled phase windows + manual override.** The league admin sets
  open/close times per phase; the **in-app scheduler** opens/closes automatically
  at those times, and the admin can also advance or extend early/late.
- Non-submission never blocks phase advance; the scheduler/admin advances
  regardless.
- **Rounds may overlap (schedule-driven).** Each round's phase windows are
  independent; if the admin schedules round N+1's submissions during round N's
  voting, they overlap — no dead time between rounds. The league page shows every
  active round with its own phase. *Winner-picks-next caveat:* round N+1's
  submissions can't open before its prompt exists; if the chooser hasn't supplied
  one by the scheduled start, authorship falls back to the admin (§9).
- **Edits while open:** players may change their submission during the submission
  window and revise their ballot (and notes) during the voting window. Everything
  freezes at close.
- **Degenerate rounds void automatically.** If **<2 submissions** exist when
  voting would open, or **zero ballots** were cast at voting close, the round
  resolves as **VOID**: no winner, no standings changes, no coins (not even
  participation), archived greyed-out as "voided". In winner-picks-next mode the
  next prompt falls back to the admin.

## 11. Submissions

- **Exactly one item per player per round.** (A "favorite trilogy" prompt is
  handled by picking one representative film.)
- **Source: the league's `MediaProvider` with free-text fallback.** A submission
  is either a canonical provider item (`{ providerType, externalId, title,
  subtitle, year, imageUrl }`) or a plain-text title when not found / provider
  unreachable. In v1 the only provider is **TMDB** (movies) — `providerType =
  "tmdb"`, `externalId = tmdbId`, `imageUrl = poster`; requires a free **TMDB API
  key** in `.env`. Duplicate detection keys on `(providerType, externalId)`.
- **Anonymous until results:** during submission and voting, films show with **no
  author**; authorship is revealed at **results** (the celebratory reveal moment).
  Players know the roster, not whose pick is whose.
- **Duplicates:** a **per-league `allowDuplicates` setting** (default **off**).
  - Off → the same TMDB film can be used once per round; a second submitter sees
    an anonymous "already submitted this round, pick another" (no name revealed).
    Free-text can't be reliably deduped → best-effort/allowed.
  - On → identical TMDB films **collapse into one anonymous ballot entry** (voting
    stays clean/secret). Its submitters are **co-submitters**; each is credited
    the film's **full** points (co-winner semantics, no splitting), and if it's
    the top film they are all co-winners.

## 12. Voting & scoring

Per-round **`votingConfig`**, method chosen by the league admin per round:

```
votingConfig = {
  method: "pool" | "ranked",
  allowSelfVote: boolean,        // default false → own film excluded from ballot

  // method = "pool":
  totalPoints:  int,             // default 10
  perFilmCap:   int | null,      // default null (= totalPoints); 1 ⇒ "likes" feel
  mustSpendAll: boolean,         // default true

  // method = "ranked":
  numRanks:         int,         // K, default 3
  weights:          "auto" | int[],  // auto = [K, K-1, …, 1]; custom optional
  mustFillAllRanks: boolean,     // default false
}
```

- `numRanks` / `perFilmCap` are **clamped to the number of eligible films**.
- A film's round score = points received; **season/league standings** = sum of a
  player's round scores.
- **Ties are allowed** everywhere: **co-winners** of a round, **co-champions** of
  a league. No arbitrary tiebreakers (points are the whole truth). The
  celebration UI shows multiple 🏆. (The *winner-picks-next* mode is the one place
  a tie is broken — by the animated random picker in §9.)
- **Vote eligibility:** default **must have submitted to vote**
  (`requireSubmissionToVote = true`), **admin-configurable per league**.
- **Full vote attribution at results:** the results screen shows each film's
  total **and the per-voter breakdown** ("bob +5, cara +4"; for ranked, "bob
  ranked you 1st"). Ballots are secret during voting, fully attributed at reveal.
- **Voter notes:** while voting, a player may attach a short free-text note to
  any item on their ballot ("watched this on my birthday, loved it!"). Notes are
  **hidden until results**, then revealed **attributed**, alongside that voter's
  points on the film.

## 13. Roles & permissions

Four roles:

- **Operator (super-admin)** — runs the instance. Gets an **in-app operator
  console**: reset any user's credentials, suspend/ban users, delete any group or
  league, and view basic instance stats. Manual credential recovery is
  operator-only (§6). Ban blocks login but does not scrub historical
  contributions unless the operator explicitly deletes them.
- **Group admin** — the group's creator. Powers: manage **group membership**
  (invite/remove members, edit group settings) **+ moderation oversight** of the
  group's leagues (delete a league; reassign a league's admin). Does **not** run
  league gameplay (prompts, scheduling, voting config) unless also a league admin.
  **Co-group-admins allowed** — same promote/demote model as leagues: the creator
  is the first admin and can promote/demote other members; any group admin has
  the full powers above.
- **League admin(s)** — **co-admins allowed**; the creator is the first admin and
  can promote/demote other league members. Any admin runs the league: prompts,
  scheduling + manual override, voting config, and roster (remove players).
- **Player** — a group and/or league member; submits, votes, views standings.

**Creation & membership:** any registered user can create a group (→ group admin)
and create a league within a group they belong to (→ league admin).

**Removal & departure:**
- A **league admin** can remove a player from their league; a **group admin** can
  remove a member from the group (cascading to that group's leagues). Removed
  players' **past submissions/points are preserved as history** (they show as
  removed/inactive).
- Players can **leave** a league or group themselves; same history-preserving rule.

**Content moderation: none in v1.** There is no per-item hide/delete of
submissions or prompts. Misbehavior is handled socially — **admins remove the
person** from the league/group, or the operator bans/deletes. (Content moderation
tooling is a possible future addition, deliberately out of v1.)

## 14. Notifications

Three channels:

1. **Web push (VAPID)** — timely nudges even when the app is closed (reused from
   `notes`' web-push; keys in `.env`; iOS requires the installed PWA).
2. **In-app notifications center** — persistent feed/badges for history and users
   without push.
3. **Outbound webhooks (per league, admin-configured)** — event types cover
   phase transitions (submissions/voting open+close, results posted), **winner
   announced**, and **new round created**. Webhook **type** is chosen per hook:
   - `generic` → documented JSON payload (custom integrations),
   - `discord` → Discord embed,
   - `slack` → Slack blocks message,
   so pasting a Discord/Slack incoming-webhook URL yields nicely-rendered channel
   messages.

## 15. Player profiles, standings & economy

**Standings & history (per league):**
- Live **standings leaderboard**.
- Browsable **round archive** — open any past round to see the prompt, the
  revealed submissions with authors, scores, and winner(s).

**Player profiles & stats (global):**
- Per-user profile page with stats: rounds played, wins, total/average scoring
  points, submission history, and cross-league aggregates. One global identity
  across all groups/leagues.

**Coins (meta-currency — global, earned-only, cosmetic-only):**
- A **separate currency from league scoring points**; one **global wallet** per
  user. Buying cosmetics never affects standings.
- **Earning, per round:** **+5 participation** (for submitting) plus a
  **podium bonus: 1st +30, 2nd +20, 3rd +10**. Voided rounds pay nothing
  (§10). Ties reuse the
  co-winner rule — everyone at a placement gets that placement's **full** coins
  (no splitting). **No anti-farm guards** (deliberate — it's a free game).
- Reward values are **instance-level constants the operator can tune via config**;
  **not** settable by league admins (so no one can mint their own currency).

**Cosmetics store (the sink):**
- v1 ships **one cosmetic type — avatar frames** (a built-in, coin-priced set) to
  prove the **earn → spend → equip** loop. More types (name colors, badges,
  banners, titles) come later.
- Modeled as a typed `CosmeticItem` (`type = "frame"` in v1) + a per-user
  **inventory** + equipped selections, so new types need **no schema change**.
- Cosmetics are purely cosmetic (no gameplay/scoring effect), attach to the
  **global profile**, and show next to the user's name in rosters, reveals, and
  standings.

## 16. Gameplay edge rules (locked defaults)

- Mid-league joiners start at 0 points and play from the next round.
- Leaving/removal keeps your past submissions/points as history; you stop
  participating going forward (see §13).

---

## 17. Scope & phasing

**v1 = everything above** (operator's explicit choice). If phasing becomes
necessary, the natural deferral cut lines are: passkeys (ship password-only
first), the ranked voting engine (pool-only first), `winner-picks-next` + the
animated randomizer, and web push + webhooks (in-app notifications first). The
irreducible core is: multi-tenant groups/leagues, password auth, self-serve
onboarding + invites, admin-scheduled rounds, one-film TMDB/free-text
submissions, pool voting, anonymous reveal + standings, in-app notifications,
polling.

## 18. Minor decisions (defaults chosen)

These were resolved with sensible defaults rather than deep discussion; revisit
if needed:

- **Round content fields:** a round's prompt is a required theme/title line plus
  an **optional longer description/rules** field.
- **Rate limiting:** apply `@fastify/rate-limit` to auth (login/register),
  invite-link acceptance, submission, and voting endpoints (per-IP + per-user).
  Coin "farming" is deliberately *not* defended against (§15).
- **TMDB resilience:** briefly cache search results in SQLite; on TMDB
  timeout/error, fall back to free-text entry; show the required TMDB attribution.
- **Data retention/export:** state lives in the SQLite volume (backup = copy it,
  as in `notes`). A per-league **CSV/JSON export** of results/standings is slated
  just **after v1**.
