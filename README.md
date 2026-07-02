# 🎬 Media League

An **easy-to-deploy** app for running a **Music League–style game** — starting
with **movies** (music and other media types planned).

Players submit **films** that best match a themed prompt — like _"favorite indie
horror"_, _"a movie that made you cry"_, or _"best sci-fi from the '80s"_ — and
then everyone votes. Points accumulate across rounds, and a champion is crowned.

Think of it as a film-buff party game — one deployment hosts many independent
**groups**, each running their own **leagues**. Each league has a media type
(v1 ships **movies**; the architecture is built so **music** and others slot in
later). The UI is meant to feel game-like: fluid, animated, and celebratory.

> ⚠️ **Status: design agreed, pre-implementation.** This repo currently contains
> the concept and the full design. The app itself is not built yet.
> **See [SPEC.md](./SPEC.md) for the complete design spec** (the decisions below
> are the friendly summary).

---

## How it works

A **league** is a group of players playing together over a series of rounds.

Each **round** flows through four phases:

1. **Prompt** — a theme is set, e.g. _"favorite indie horror"_.
2. **Submission** — every player secretly submits one movie that fits the prompt.
3. **Voting** — submissions are revealed anonymously and each player distributes
   a fixed pool of votes across the movies they like best (you can't vote for
   your own).
4. **Results** — votes are tallied into points, authorship is revealed, the
   round winner is crowned, and the league standings update.

Do this for as many rounds as you like. The player with the most accumulated
points across the league's rounds wins.

### Scoring

- Each round uses one of two voting engines, chosen by the league admin:
  **point-pool** (allocate a budget of points across films; a per-film cap of 1
  gives a "likes" feel) or **ranked** (rank your top K; positional weights).
- A film's round score = the points it received; **standings** = the sum of a
  player's round scores.
- **Ties are allowed** — co-winners of a round, co-champions of a league.

---

## Highlights

- 🎥 Themed prompts, one film per player, submitted via **TMDB** search (with a
  free-text fallback) so films come with posters
- 🗳️ Per-round **point-pool or ranked** voting, anonymous until the results reveal
- 🏆 Automatic tallying, per-league standings, and an animated **winner reveal**
- 🎲 Optional **winner-picks-the-next-prompt** mode, with an animated randomizer
  breaking ties
- 👥 **Multi-tenant**: many isolated groups, each running multiple leagues
- 🔒 Username + password auth with **optional passkeys**; no email required
- 🔔 **Web push**, an in-app notifications center, and **Slack/Discord webhooks**
- 🐳 Easy deploy: one Docker Compose stack (app + Caddy auto-HTTPS), SQLite in a
  volume, config via `.env`

See **[SPEC.md](./SPEC.md)** for the full design and rationale.

---

## License

MIT — see [LICENSE](./LICENSE).
