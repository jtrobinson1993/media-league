import type { MediaItem, MediaType } from '@media-league/shared';
import type { DB } from '../db.js';
import type { Config } from '../config.js';

/** SPEC §1: the seam future media types (music, …) plug into. */
export interface MediaProvider {
  readonly providerType: string;
  search(query: string): Promise<MediaItem[]>;
}

export type MediaRegistry = Partial<Record<MediaType, MediaProvider>>;

const CACHE_TTL_MS = 10 * 60_000; // SPEC §19: brief TMDB cache

export function cachedSearch(db: DB, provider: MediaProvider, query: string): Promise<MediaItem[]> {
  const key = `${provider.providerType}:${query.toLowerCase()}`;
  const hit = db
    .prepare('SELECT payload FROM media_cache WHERE cache_key = ? AND expires_at > ?')
    .get(key, Date.now()) as { payload: string } | undefined;
  if (hit) return Promise.resolve(JSON.parse(hit.payload) as MediaItem[]);

  return provider.search(query).then((items) => {
    db.prepare(
      'INSERT INTO media_cache (cache_key, payload, expires_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT (cache_key) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at',
    ).run(key, JSON.stringify(items), Date.now() + CACHE_TTL_MS);
    return items;
  });
}

interface TmdbMovie {
  id: number;
  title: string;
  original_title?: string;
  release_date?: string;
  poster_path?: string | null;
}

export class TmdbProvider implements MediaProvider {
  readonly providerType = 'tmdb';
  constructor(private readonly apiKey: string) {}

  async search(query: string): Promise<MediaItem[]> {
    const url = new URL('https://api.themoviedb.org/3/search/movie');
    url.searchParams.set('query', query);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('include_adult', 'false');

    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`tmdb search failed: ${res.status}`);
    const body = (await res.json()) as { results?: TmdbMovie[] };
    return (body.results ?? []).slice(0, 10).map((m) => ({
      providerType: 'tmdb' as const,
      externalId: String(m.id),
      title: m.title,
      subtitle: m.original_title && m.original_title !== m.title ? m.original_title : null,
      year: m.release_date ? Number(m.release_date.slice(0, 4)) : null,
      imageUrl: m.poster_path ? `https://image.tmdb.org/t/p/w342${m.poster_path}` : null,
    }));
  }
}

export function defaultRegistry(config: Config): MediaRegistry {
  return config.tmdbApiKey ? { movie: new TmdbProvider(config.tmdbApiKey) } : {};
}
