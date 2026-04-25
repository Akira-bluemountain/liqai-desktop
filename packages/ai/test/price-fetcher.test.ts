import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CoinGeckoProvider,
  MemoryPriceCache,
  PriceFetcher,
  type PriceProvider,
  type PriceSeries,
} from '../src/price-fetcher.js';

describe('MemoryPriceCache', () => {
  it('stores and retrieves within TTL', async () => {
    const cache = new MemoryPriceCache();
    const sample: PriceSeries = {
      symbol: 'ETH',
      prices: [1, 2, 3],
      timestamps: [100, 200, 300],
      fetchedAt: 300,
      source: 'test',
    };
    await cache.set('k', sample, 60);
    const hit = await cache.get('k');
    expect(hit).toEqual(sample);
  });

  it('returns null for expired entries', async () => {
    const cache = new MemoryPriceCache();
    const sample: PriceSeries = {
      symbol: 'ETH',
      prices: [1],
      timestamps: [1],
      fetchedAt: 1,
      source: 'test',
    };
    await cache.set('k', sample, 0);
    await new Promise((r) => setTimeout(r, 5));
    const hit = await cache.get('k');
    expect(hit).toBeNull();
  });
});

describe('CoinGeckoProvider', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('parses a well-formed response', async () => {
    const mockJson = {
      prices: [
        [1_700_000_000_000, 2000.5],
        [1_700_003_600_000, 2001.2],
      ],
    };
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(mockJson), { status: 200 }),
    ) as unknown as typeof fetch;

    const provider = new CoinGeckoProvider();
    const series = await provider.fetchHistoricalPrices('ETH', 1);
    expect(series.symbol).toBe('ETH');
    expect(series.prices).toEqual([2000.5, 2001.2]);
    expect(series.timestamps).toEqual([1_700_000_000, 1_700_003_600]);
    expect(series.source).toBe('coingecko');
  });

  it('rejects unsupported symbols (prevents URL path injection)', async () => {
    const provider = new CoinGeckoProvider();
    await expect(
      provider.fetchHistoricalPrices('FAKECOIN', 1),
    ).rejects.toThrow(/unsupported symbol/);

    await expect(
      provider.fetchHistoricalPrices('../etc/passwd', 1),
    ).rejects.toThrow(/unsupported symbol/);
  });

  it('rejects out-of-range days', async () => {
    const provider = new CoinGeckoProvider();
    await expect(provider.fetchHistoricalPrices('ETH', 0)).rejects.toThrow();
    await expect(provider.fetchHistoricalPrices('ETH', -1)).rejects.toThrow();
    await expect(provider.fetchHistoricalPrices('ETH', 366)).rejects.toThrow();
    await expect(provider.fetchHistoricalPrices('ETH', NaN)).rejects.toThrow();
  });

  it('throws on non-2xx responses', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('rate limited', { status: 429 }),
    ) as unknown as typeof fetch;

    const provider = new CoinGeckoProvider();
    await expect(
      provider.fetchHistoricalPrices('ETH', 1),
    ).rejects.toThrow(/HTTP 429/);
  });

  it('rejects malformed response body (defence against compromised API)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ unexpected: 'shape' }), { status: 200 }),
    ) as unknown as typeof fetch;

    const provider = new CoinGeckoProvider();
    await expect(
      provider.fetchHistoricalPrices('ETH', 1),
    ).rejects.toThrow();
  });

  it('rejects response with negative prices (defence against API compromise)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ prices: [[1_700_000_000_000, -100]] }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const provider = new CoinGeckoProvider();
    await expect(
      provider.fetchHistoricalPrices('ETH', 1),
    ).rejects.toThrow();
  });

  it('rejects response with oversized array (DoS guard)', async () => {
    const huge = Array.from({ length: 100_000 }, (_, i) => [
      1_700_000_000_000 + i * 1000,
      2000,
    ]);
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ prices: huge }), { status: 200 }),
    ) as unknown as typeof fetch;

    const provider = new CoinGeckoProvider();
    await expect(
      provider.fetchHistoricalPrices('ETH', 1),
    ).rejects.toThrow();
  });

  it('hits configured host only (no arbitrary URL)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ prices: [[1_700_000_000_000, 1]] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    const provider = new CoinGeckoProvider();
    await provider.fetchHistoricalPrices('ETH', 1);

    const call = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    const urlArg = call?.[0] as string;
    expect(urlArg.startsWith('https://api.coingecko.com/')).toBe(true);
  });
});

describe('PriceFetcher', () => {
  it('uses the provider when no cache is configured', async () => {
    const series: PriceSeries = {
      symbol: 'ETH',
      prices: [1, 2, 3],
      timestamps: [1, 2, 3],
      fetchedAt: 3,
      source: 'mock',
    };
    const provider: PriceProvider = {
      fetchHistoricalPrices: vi.fn(async () => series),
    };
    const fetcher = new PriceFetcher(provider);
    const out = await fetcher.getHistoricalPrices('ETH', 1);
    expect(out).toEqual(series);
    expect(provider.fetchHistoricalPrices).toHaveBeenCalledTimes(1);
  });

  it('serves cached results without re-fetching', async () => {
    const series: PriceSeries = {
      symbol: 'ETH',
      prices: [1, 2, 3],
      timestamps: [1, 2, 3],
      fetchedAt: 3,
      source: 'mock',
    };
    const provider: PriceProvider = {
      fetchHistoricalPrices: vi.fn(async () => series),
    };
    const cache = new MemoryPriceCache();
    const fetcher = new PriceFetcher(provider, cache);

    await fetcher.getHistoricalPrices('ETH', 1, { cacheTtlSeconds: 60 });
    await fetcher.getHistoricalPrices('ETH', 1, { cacheTtlSeconds: 60 });

    expect(provider.fetchHistoricalPrices).toHaveBeenCalledTimes(1);
  });
});
