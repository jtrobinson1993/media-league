import type { VotingConfig } from '@media-league/shared';

/** Validate + normalize an incoming voting config; returns null if invalid. */
export function parseVotingConfig(input: unknown): VotingConfig | null {
  if (typeof input !== 'object' || input === null) return null;
  const cfg = input as Record<string, unknown>;
  const allowSelfVote = cfg.allowSelfVote === true;

  if (cfg.method === 'pool') {
    const totalPoints = Number(cfg.totalPoints ?? 10);
    const perItemCap = cfg.perItemCap == null ? null : Number(cfg.perItemCap);
    if (!Number.isInteger(totalPoints) || totalPoints < 1 || totalPoints > 1000) return null;
    if (perItemCap !== null && (!Number.isInteger(perItemCap) || perItemCap < 1 || perItemCap > totalPoints)) {
      return null;
    }
    return {
      method: 'pool',
      allowSelfVote,
      totalPoints,
      perItemCap,
      mustSpendAll: cfg.mustSpendAll !== false,
    };
  }

  if (cfg.method === 'ranked') {
    const numRanks = Number(cfg.numRanks ?? 3);
    if (!Number.isInteger(numRanks) || numRanks < 1 || numRanks > 50) return null;
    let weights: 'auto' | number[] = 'auto';
    if (Array.isArray(cfg.weights)) {
      if (cfg.weights.length !== numRanks) return null;
      if (!cfg.weights.every((w) => Number.isInteger(w) && w >= 0 && w <= 1000)) return null;
      weights = cfg.weights as number[];
    } else if (cfg.weights !== undefined && cfg.weights !== 'auto') {
      return null;
    }
    return {
      method: 'ranked',
      allowSelfVote,
      numRanks,
      weights,
      mustFillAllRanks: cfg.mustFillAllRanks === true,
    };
  }

  return null;
}
