# 🎬 Movie League

A self-hostable app for running a **Music League–style game with movies**.

Instead of submitting songs, players submit **films** that best match a themed
prompt — like _"favorite indie horror"_, _"a movie that made you cry"_, or
_"best sci-fi from the '80s"_ — and then everyone votes. Points accumulate
across rounds, and a champion is crowned at the end of the season.

Think of it as a film-buff party game you host for your friends, entirely on
your own server.

> ⚠️ **Status: early / planning.** This repo currently contains the concept and
> design. The app itself is not built yet — see the [Roadmap](#roadmap).

---

## How it works

A **league** is a group of players playing together over a series of rounds.

Each **round** flows through four phases:

1. **Prompt** — a theme is set, e.g. _"favorite indie horror"_.
2. **Submission** — every player secretly submits one movie that fits the prompt.
3. **Voting** — submissions are revealed anonymously and each player distributes
   a fixed pool of votes across the movies they like best (you can't vote for
   your own).
4. **Results** — votes are tallied into points, the round winner is revealed,
   and the season standings update.

Do this for as many rounds as you like. The player with the most accumulated
points across the season wins the league.

### Scoring

- Each voter gets a fixed number of vote points per round.
- They allocate those points across submissions (e.g. 5 to one film, 3 to
  another, 2 to a third).
- A submission's score for the round = the sum of points it received.
- Season standings = the sum of a player's round scores.

---

## Goals

- 🎥 Themed prompts and per-round movie submissions
- 🗳️ Anonymous, weighted voting with an anti–self-vote rule
- 🏆 Automatic point tallying and season-long standings
- 👥 Multiple independent leagues on one instance
- 🔒 Simple auth — no third-party accounts required
- 🐳 Easy self-hosting, ideally one command
- 💾 Simple, portable storage that's trivial to back up

---

## Roadmap

- [ ] Core data model (leagues, rounds, submissions, votes)
- [ ] Auth & player accounts
- [ ] Round lifecycle (prompt → submit → vote → results)
- [ ] Voting + scoring engine
- [ ] Season standings
- [ ] Web UI
- [ ] One-command self-hosting (Docker)
- [ ] TMDB integration for movie search & posters

---

## License

MIT — see [LICENSE](./LICENSE).
