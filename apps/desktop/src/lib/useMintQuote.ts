'use client';

/**
 * useMintQuote — fetches ETH/USD price history from CoinGecko and runs the
 * @liqai/ai Bollinger Band range calculator to produce a "sweet spot" range
 * for an ETH/USDC LP position.
 *
 * SECURITY:
 *   - Symbol is hard-coded ("ETH"); never user-controlled. Prevents path
 *     injection into CoinGecko URL.
 *   - calculateSweetSpot runs RangeInputSchema and SweetSpotResultSchema
 *     internally. We surface validation errors instead of falling back to
 *     dangerous defaults.
 *   - All amounts in this hook are for DISPLAY only. The mint flow MUST
 *     re-derive ticks against the live pool's slot0 (decimal-aware) before
 *     constructing any transaction.
 *
 * Fee tier choice: 0.05% (500). This is the highest-volume USDC/WETH pool
 * on mainnet and gives the best fill quality for our typical position
 * sizes.
 */

import { useQuery } from '@tanstack/react-query';
import { CoinGeckoProvider, calculateSweetSpot } from '@liqai/ai';
import type { SweetSpotResult } from '@liqai/ai';

const HISTORY_DAYS = 7;
/** USDC/WETH 0.05% fee tier — highest mainnet volume. */
export const QUOTE_FEE_TIER = 500;

export interface MintQuote {
  /** Latest ETH price in USD (from CoinGecko). */
  readonly currentEthUsd: number;
  /** Number of historical price points used. */
  readonly historyPointCount: number;
  /** AI-computed sweet spot range. */
  readonly sweetSpot: SweetSpotResult;
  /** When the quote was generated (ms epoch). */
  readonly generatedAt: number;
}

export interface UseMintQuoteResult {
  readonly data: MintQuote | undefined;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => void;
}

export function useMintQuote(): UseMintQuoteResult {
  const query = useQuery({
    queryKey: ['mint-quote', 'ETH', HISTORY_DAYS, QUOTE_FEE_TIER],
    queryFn: async (): Promise<MintQuote> => {
      const provider = new CoinGeckoProvider();
      const series = await provider.fetchHistoricalPrices('ETH', HISTORY_DAYS);
      if (series.prices.length < 10) {
        throw new Error(
          `Insufficient price history (${series.prices.length} points; need >=10)`,
        );
      }
      const lastPrice = series.prices[series.prices.length - 1];
      if (typeof lastPrice !== 'number' || !Number.isFinite(lastPrice) || lastPrice <= 0) {
        throw new Error('Invalid current ETH price from CoinGecko');
      }

      const sweetSpot = calculateSweetSpot({
        prices: series.prices,
        currentPrice: lastPrice,
        feeTier: QUOTE_FEE_TIER,
        holdingPeriodDays: HISTORY_DAYS,
        k: 1.5,
      });

      return {
        currentEthUsd: lastPrice,
        historyPointCount: series.prices.length,
        sweetSpot,
        generatedAt: Date.now(),
      };
    },
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    retry: 2,
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: query.refetch,
  };
}
