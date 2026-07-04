import { DEFAULT_COIN_REWARDS, type CoinRewards } from '@media-league/shared';

export interface Config {
  port: number;
  /** Canonical public URL; passkey RP ID and origin derive from it. */
  appOrigin: string;
  databasePath: string;
  /** Blob storage dir (avatar photos). */
  dataDir: string;
  sessionTtlDays: number;
  tmdbApiKey: string | null;
  vapidPublicKey: string | null;
  vapidPrivateKey: string | null;
  coinRewards: CoinRewards;
  /** Username of the account granted operator (super-admin) powers. */
  operatorUsername: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const appOrigin = env.APP_ORIGIN ?? 'http://localhost:3000';
  return {
    port: env.PORT ? Number(env.PORT) : 3000,
    appOrigin,
    databasePath: env.DATABASE_PATH ?? './data/media-league.db',
    dataDir: env.DATA_DIR ?? './data',
    sessionTtlDays: env.SESSION_TTL_DAYS ? Number(env.SESSION_TTL_DAYS) : 90,
    tmdbApiKey: env.TMDB_API_KEY ?? null,
    vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null,
    vapidPrivateKey: env.VAPID_PRIVATE_KEY ?? null,
    coinRewards: {
      participation: env.COINS_PARTICIPATION
        ? Number(env.COINS_PARTICIPATION)
        : DEFAULT_COIN_REWARDS.participation,
      podium: [
        env.COINS_FIRST ? Number(env.COINS_FIRST) : DEFAULT_COIN_REWARDS.podium[0],
        env.COINS_SECOND ? Number(env.COINS_SECOND) : DEFAULT_COIN_REWARDS.podium[1],
        env.COINS_THIRD ? Number(env.COINS_THIRD) : DEFAULT_COIN_REWARDS.podium[2],
      ],
    },
    operatorUsername: env.OPERATOR_USERNAME ?? null,
  };
}
