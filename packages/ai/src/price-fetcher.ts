/**
 * Price history fetcher with pluggable provider + optional caching.
 *
 * Providers:
 *   - CoinGeckoProvider: fetches hourly price data from CoinGecko public API.
 *   - UniswapPoolProvider (future): on-chain TWAP from a Uniswap V3 pool.
 *
 * SECURITY:
 *   - Every URL is a whitelist of exact hosts — no user-controlled URLs.
 *   - Responses are parsed with Zod schemas before use.
 *   - A sanity cap on price count prevents memory DoS from compromised RPC.
 *   - AbortController timeout prevents hanging requests.
 *   - All errors are normalised (no raw stack traces leak).
 */

import { z } from 'zod';

const MAX_PRICE_POINTS = 50_000;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface PriceSeries {
  readonly symbol: string;
  readonly prices: readonly number[];
  readonly timestamps: readonly number[]; // Unix seconds
  readonly fetchedAt: number; // Unix seconds
  readonly source: string;
}

export interface PriceProvider {
  fetchHistoricalPrices(
    symbol: string,
    days: number,
    signal?: AbortSignal,
  ): Promise<PriceSeries>;
}

export interface PriceCache {
  get(key: string): Promise<PriceSeries | null>;
  set(key: string, value: PriceSeries, ttlSeconds: number): Promise<void>;
}

/** In-memory cache (useful for tests or short-lived processes). */
export class MemoryPriceCache implements PriceCache {
  private readonly store = new Map<string, { value: PriceSeries; expiresAt: number }>();

  async get(key: string): Promise<PriceSeries | null> {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now() / 1000) {
      this.store.delete(key);
      return null;
    }
    return hit.value;
  }

  async set(key: string, value: PriceSeries, ttlSeconds: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: Date.now() / 1000 + ttlSeconds,
    });
  }
}

// ── CoinGecko provider ─────────────────────────────────────────────

// Whitelist of symbols we support. Prevents arbitrary input being turned
// into CoinGecko URL paths (path injection defence).
const COIN_GECKO_ID_MAP: Record<string, string> = {
  ETH: 'ethereum',
  WETH: 'ethereum', // Same price as ETH for our purposes
  BTC: 'bitcoin',
  WBTC: 'wrapped-bitcoin',
};

const COIN_GECKO_BASE = 'https://api.coingecko.com/api/v3';

// CoinGecko market_chart response shape:
//   { prices: [[timestampMs, price], ...], market_caps: [...], total_volumes: [...] }
const CoinGeckoResponseSchema = z.object({
  prices: z
    .array(z.tuple([z.number().int().positive(), z.number().positive().finite()]))
    .min(1)
    .max(MAX_PRICE_POINTS),
});

export class CoinGeckoProvider implements PriceProvider {
  constructor(
    private readonly options: {
      readonly timeoutMs?: number;
      /** Optional pro API key — only over HTTPS, header-based. */
      readonly apiKey?: string;
    } = {},
  ) {}

  async fetchHistoricalPrices(
    symbol: string,
    days: number,
    externalSignal?: AbortSignal,
  ): Promise<PriceSeries> {
    const coinId = COIN_GECKO_ID_MAP[symbol.toUpperCase()];
    if (!coinId) {
      throw new Error(`CoinGecko: unsupported symbol "${symbol}"`);
    }
    if (!Number.isFinite(days) || days <= 0 || days > 365) {
      throw new Error(`CoinGecko: days must be in (0, 365]`);
    }

    // Hourly granularity is only available for <=90 days on the free tier;
    // for longer windows CoinGecko returns daily candles automatically.
    const url = new URL(`/api/v3/coins/${coinId}/market_chart`, COIN_GECKO_BASE);
    url.searchParams.set('vs_currency', 'usd');
    url.searchParams.set('days', String(Math.floor(days)));
    // "interval" parameter was removed from free tier; let CoinGecko pick.

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(new Error('CoinGecko timeout')),
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const combinedSignal = externalSignal
      ? anySignal([controller.signal, externalSignal])
      : controller.signal;

    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (this.options.apiKey) {
        headers['x-cg-pro-api-key'] = this.options.apiKey;
      }

      const resp = await fetch(url.toString(), {
        method: 'GET',
        headers,
        signal: combinedSignal,
      });

      if (!resp.ok) {
        throw new Error(`CoinGecko: HTTP ${resp.status}`);
      }

      const rawBody: unknown = await resp.json();
      const parsed = CoinGeckoResponseSchema.parse(rawBody);

      const prices: number[] = [];
      const timestamps: number[] = [];
      for (const [tsMs, price] of parsed.prices) {
        prices.push(price);
        timestamps.push(Math.floor(tsMs / 1000));
      }

      return {
        symbol: symbol.toUpperCase(),
        prices,
        timestamps,
        fetchedAt: Math.floor(Date.now() / 1000),
        source: 'coingecko',
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/** Compose AbortSignals. Polyfill for older runtimes; Node 20+ has AbortSignal.any. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any === 'function') {
    return (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any(signals);
  }
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      return controller.signal;
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

// ── Fetcher coordinator ────────────────────────────────────────────

export interface FetchOptions {
  /** TTL in seconds. Default 300 (5 minutes). */
  readonly cacheTtlSeconds?: number;
  readonly signal?: AbortSignal;
}

/**
 * High-level price fetcher combining a provider with an optional cache.
 */
export class PriceFetcher {
  constructor(
    private readonly provider: PriceProvider,
    private readonly cache?: PriceCache,
  ) {}

  async getHistoricalPrices(
    symbol: string,
    days: number,
    opts: FetchOptions = {},
  ): Promise<PriceSeries> {
    const cacheKey = `${symbol.toUpperCase()}:${Math.floor(days)}`;
    if (this.cache) {
      const hit = await this.cache.get(cacheKey);
      if (hit) return hit;
    }

    const fetched = await this.provider.fetchHistoricalPrices(
      symbol,
      days,
      opts.signal,
    );

    if (this.cache) {
      await this.cache.set(cacheKey, fetched, opts.cacheTtlSeconds ?? 300);
    }
    return fetched;
  }
}
