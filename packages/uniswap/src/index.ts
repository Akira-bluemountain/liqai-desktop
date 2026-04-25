/**
 * @liqai/uniswap — Direct Uniswap V3 interaction helpers for user-owned LPs.
 *
 * This package builds unsigned transactions and reads pool state. It NEVER
 * signs or submits transactions — signing is delegated to the user's wallet
 * or a scoped ERC-4337 session key.
 */

export {
  UNISWAP_V3_ADDRESSES,
  UNISWAP_V3_NPM_SELECTORS,
  getAddresses,
  isSupportedChain,
  type SupportedChainId,
} from './addresses.js';

export {
  NONFUNGIBLE_POSITION_MANAGER_ABI,
  FACTORY_ABI,
  POOL_ABI,
  SWAP_ROUTER_02_ABI,
  QUOTER_V2_ABI,
  ERC20_ABI,
} from './abis.js';

export {
  sqrtPriceX96ToPrice,
  computePositionAmounts,
  withSlippage,
} from './price-math.js';

export {
  usdPerAssetToPoolRawPrice,
  poolRawPriceToUsdPerAsset,
  rawPriceToTick,
  usdRangeToPoolTickRange,
  usdPerAssetToSqrtPriceX96,
} from './pool-tick-conversion.js';

export {
  getPoolAddress,
  getPoolState,
  getTokenDecimals,
  type PoolState,
} from './pool-state.js';

export {
  buildSwapTx,
  buildMintTx,
  buildDecreaseLiquidityTx,
  buildCollectTx,
  MAX_SLIPPAGE_BPS,
  MAX_DEADLINE_SEC,
  type UnsignedTx,
  type BuildSwapTxOptions,
  type BuildMintTxOptions,
  type BuildDecreaseLiquidityTxOptions,
  type BuildCollectTxOptions,
} from './tx-builder.js';
