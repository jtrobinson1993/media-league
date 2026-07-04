// Core domain types shared between server and web. These mirror SPEC.md and
// are the contract for the JSON API.

export type MediaType = 'movie';

export type ProviderType = 'tmdb';

/** Canonical media item returned by a MediaProvider (SPEC §1). */
export interface MediaItem {
  providerType: ProviderType;
  externalId: string;
  title: string;
  subtitle: string | null;
  year: number | null;
  imageUrl: string | null;
}

/** A player's submission: either a canonical provider item or free text. */
export type SubmissionContent =
  | { kind: 'provider'; item: MediaItem }
  | { kind: 'freeText'; title: string };

export type RoundPhase =
  | 'scheduled' // created, submission window not yet open
  | 'submitting'
  | 'voting'
  | 'finished'
  | 'voided';

export type PromptMode = 'admin' | 'winner-picks-next';

export type LeagueVisibility = 'public' | 'private';

/** Per-round voting configuration (SPEC §12). */
export type VotingConfig =
  | {
      method: 'pool';
      allowSelfVote: boolean;
      totalPoints: number;
      perItemCap: number | null; // null = totalPoints; 1 ⇒ "likes" feel
      mustSpendAll: boolean;
    }
  | {
      method: 'ranked';
      allowSelfVote: boolean;
      numRanks: number;
      weights: 'auto' | number[]; // auto = [K, K-1, …, 1]
      mustFillAllRanks: boolean;
    };

export const DEFAULT_POOL_CONFIG: VotingConfig = {
  method: 'pool',
  allowSelfVote: false,
  totalPoints: 10,
  perItemCap: null,
  mustSpendAll: true,
};

export const DEFAULT_RANKED_CONFIG: VotingConfig = {
  method: 'ranked',
  allowSelfVote: false,
  numRanks: 3,
  weights: 'auto',
  mustFillAllRanks: false,
};

/** League schedule template (SPEC §16 — cadence template). */
export interface ScheduleTemplate {
  /** ISO weekday 1-7 (Mon-Sun) a new round's submission window opens. */
  startWeekday: number;
  /** "HH:MM" local time the submission window opens. */
  startTime: string;
  submissionDays: number;
  votingDays: number;
}

export type GroupRole = 'admin' | 'member';
export type MembershipStatus = 'active' | 'removed' | 'left';

/** Coin rewards (SPEC §15) — instance-level, operator-tunable. */
export interface CoinRewards {
  participation: number;
  podium: [number, number, number]; // 1st, 2nd, 3rd
}

export const DEFAULT_COIN_REWARDS: CoinRewards = {
  participation: 5,
  podium: [30, 20, 10],
};

export type CosmeticType = 'frame';

export type AvatarConfig =
  | { kind: 'initials'; color: string }
  | { kind: 'gallery'; id: string; color: string }
  | { kind: 'photo' }; // photo stored server-side keyed by user id

export type InviteKind = 'standing' | 'one-time';
export type InviteScope = 'group' | 'league';

export type WebhookFormat = 'generic' | 'discord' | 'slack';

export type WebhookEvent =
  | 'round.created'
  | 'submissions.open'
  | 'submissions.closed'
  | 'voting.open'
  | 'voting.closed'
  | 'results.posted'
  | 'winner.announced';

export type NotificationType =
  | 'submissions.open'
  | 'submissions.closing'
  | 'voting.open'
  | 'voting.closing'
  | 'results.posted'
  | 'round.voided'
  | 'prompt.your-turn'
  | 'coins.earned';

/** Resolve ranked weights: auto ⇒ [K, K-1, …, 1]. */
export function resolveRankWeights(cfg: Extract<VotingConfig, { method: 'ranked' }>): number[] {
  if (cfg.weights !== 'auto') return cfg.weights;
  return Array.from({ length: cfg.numRanks }, (_, i) => cfg.numRanks - i);
}
