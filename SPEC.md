# Movie League — Design Spec

Status: **design agreed, pre-implementation.** This document captures the
decisions made while stress-testing the concept. It is the source of truth for
what we're building; the README is the friendly summary.

> **v1 scope note:** We deliberately chose a **feature-complete v1** — every
> feature below is in the first release, nothing deferred. This is an ambitious
> first build; if it needs to be broken into phases later, the natural cut lines
> are called out in [§13](#13-scope--phasing).

---

## 1. Concept

A Music League–style party game for **movies**. Players in a league are given a
themed **prompt** (e.g. _"favorite indie horror"_), each secretly submits one
film that fits, everyone votes anonymously, points are tallied, a round winner
is crowned, and points accumulate into league standings. The UI should feel
**game-like**: fluid, animated, and celebratory (win effects, an animated
randomizer for tie-breaks).

---

## 2. Product framing

- **Easy-to-deploy hosted app**, operated by a single operator (you). *Not*
  positioned as "self-hostable for strangers" — but **ease of deploy is a
  first-class design constraint** (the operator is not a devops specialist).
- One deployment is **multi-tenant**: it hosts many isolated communities.

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
  **Tailwind v4** + **reka-ui**; **`@simplewebauthn/browser`**; **`@vueuse/motion`
  / motion-v + GSAP** for the game-feel animations. Built as a **client-side SPA**
  that talks to the Fastify JSON API (no meta-framework).
- **Tests:** vitest + playwright.
- **Real-time:** **none** — clients use **lightweight polling**. (WebSockets were
  considered and rejected for v1; see §11.)

---

## 5. Tenancy & identity

- **Full multi-tenant:** one instance hosts many **isolated communities**.
- **Global user accounts** + a **membership** table linking a user to each
  community they belong to, carrying a **role**. One login; a community switcher
  in the UI. All tenant-scoped queries filter by `(user, community)`.

## 6. Authentication & recovery

- **Identifier: username.** **Auth: username + password**, with **optional
  passkey (WebAuthn)** as an add-on. No email is stored; **no SMTP anywhere**.
  - *Constraint:* passkeys require a configured public origin/RP-ID + HTTPS
    (satisfied by `APP_ORIGIN` + Caddy).
- **Recovery: server-admin (operator) manual only.** No self-service reset, no
  recovery codes, no email. This is **not surfaced as a user feature**; users are
  told at signup to keep their credentials safe.

## 7. Onboarding & invites

- **Self-serve:** any registered user can **create a community** and becomes its
  **community admin**. Others join via a **shareable invite link / join code**.
- The instance is open to sign-ups (an operator-level gate on registration is a
  possible future knob, not in scope now).

---

## 8. Domain hierarchy

```
Community → League → Round
```

No "season" layer — if someone wants seasons, they put it in the league name.
Standings are **per-league**, summed across that league's rounds.

## 9. Leagues

- **Opt-in participation with per-league rosters** (`league_members`). A
  community can run **multiple concurrent leagues** with different participants.
- **Visibility (per league):** `public` (listed in the community's league
  directory, any member can join) or `private` (unlisted, join only via invite).
- **League invite links onboard outsiders:** following a league link joins a
  non-member to the **community *and* that league** in one step.
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

## 11. Submissions

- **Exactly one film per player per round.** (A "favorite trilogy" prompt is
  handled by picking one representative film.)
- **Movie source: TMDB search with free-text fallback.** A submission is either
  a canonical TMDB film (`tmdbId, title, year, posterUrl`) or a plain-text title
  when not found / TMDB unreachable. Requires a free **TMDB API key** in `.env`.
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

## 13. Notifications

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

## 14. Gameplay edge rules (locked defaults)

- Mid-league joiners start at 0 points and play from the next round.
- Leaving a league keeps your past submissions/points as history; you stop
  participating going forward.

---

## 15. Scope & phasing

**v1 = everything above** (operator's explicit choice). If phasing becomes
necessary, the natural deferral cut lines are: passkeys (ship password-only
first), the ranked voting engine (pool-only first), `winner-picks-next` + the
animated randomizer, and web push + webhooks (in-app notifications first). The
irreducible core is: multi-tenant communities/leagues, password auth, self-serve
onboarding + invites, admin-scheduled rounds, one-film TMDB/free-text
submissions, pool voting, anonymous reveal + standings, in-app notifications,
polling.

## 16. Open questions (not yet decided)

- **Roles & permissions matrix** — precise powers of operator/super-admin vs
  community admin vs league admin vs player (e.g. can a community admin moderate
  or delete leagues they didn't create? remove members? ban?).
- **Round content fields** beyond prompt text (optional description/rules?).
- **Standings & history surfaces** — per-round history, past leagues, player
  profiles/stats.
- **Rate limiting / abuse** specifics (invite-link abuse, vote manipulation).
- **TMDB resilience** — caching, attribution requirements, and behavior when the
  API is down (beyond the free-text fallback).
- **Data retention / export / backups** beyond copying the SQLite volume.
