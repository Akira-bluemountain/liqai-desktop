/**
 * Canonical Uniswap V3 contract addresses by chain.
 *
 * SECURITY (docs/security-v2.md S3.1):
 *   - Only canonical, audited addresses are listed here.
 *   - No user input EVER reaches these constants.
 *   - Any on-chain interaction MUST target one of these addresses.
 *
 * Source: https://docs.uniswap.org/contracts/v3/reference/deployments
 */

export const UNISWAP_V3_ADDRESSES = {
  // Ethereum mainnet (chainId 1)
  1: {
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    nonfungiblePositionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', // QuoterV2
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
} as const;

export type SupportedChainId = keyof typeof UNISWAP_V3_ADDRESSES;

/** Returns true iff the chainId has LiqAI v2 support configured. */
export function isSupportedChain(chainId: number): chainId is SupportedChainId {
  return chainId === 1;
}

/** Look up addresses for a supported chain. Throws for unsupported chains. */
export function getAddresses(chainId: number) {
  if (!isSupportedChain(chainId)) {
    throw new Error(
      `Uniswap V3 addresses not configured for chainId=${chainId}. ` +
        `Only Ethereum mainnet (1) is supported in v2 MVP.`,
    );
  }
  return UNISWAP_V3_ADDRESSES[chainId];
}

/** Function selectors for the session key allowlist. */
export const UNISWAP_V3_NPM_SELECTORS = {
  mint: '0x88316456',
  decreaseLiquidity: '0x0c49ccbe',
  collect: '0xfc6f7865',
  burn: '0x42966c68',
} as const;
