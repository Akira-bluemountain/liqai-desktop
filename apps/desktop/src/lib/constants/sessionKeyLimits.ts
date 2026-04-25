/**
 * Security-relevant numeric limits, gathered in one audit-friendly place.
 *
 * Why a dedicated file:
 *   These constants define the blast radius of a compromised session key.
 *   Keeping them co-located means any review or audit can verify ALL the
 *   policy caps in a single diff, without hunting through the policy
 *   builder or the Kernel SDK call sites.
 *
 *   Changing any value here is a security change. Every modification must
 *   go through code review with justification, and the session-key policy
 *   regression tests must be updated accordingly (they assert these caps
 *   are actually plumbed into the on-chain CallPolicy rules).
 *
 * Units:
 *   Amounts are stored as bigints in the token's smallest unit (wei for
 *   WETH, micro-USDC for USDC). We never pass a float through policy
 *   construction.
 */

/**
 * Maximum USDC amount a session-key-issued `approve(NPM, amount)` call
 * may authorise. Enforced on-chain via ParamCondition.LESS_THAN_OR_EQUAL
 * at byte offset 32 (the `amount` slot of `approve(address,uint256)`).
 *
 * Chosen at ~10x of the MVP upper-bound position size ($5,000):
 *   - Gives 10x headroom over any normal rebalance's approve amount.
 *   - Still bounds the attacker's maximum USDC siphon per approve to
 *     $50,000, which combined with recipient pinning on mint/collect
 *     reduces practical theft vectors to "none" (recipient pinning is
 *     the primary defence; this cap is defence-in-depth).
 *
 * If the user's position ever exceeds $50,000 USDC-equivalent, this cap
 * must be raised — the user will see a revert during rebalance with a
 * clear error pointing at this file. A future enhancement scopes the cap
 * per-session-key at issuance time based on the position being managed.
 */
export const MAX_APPROVE_AMOUNT_USDC: bigint = 50_000n * 10n ** 6n; // 50,000 USDC

/**
 * Maximum WETH amount a session-key-issued `approve(NPM, amount)` call
 * may authorise. Same rationale as USDC cap, sized to WETH decimals.
 * At $3,000/ETH this is ~$60,000 worth — comparable 10x headroom.
 */
export const MAX_APPROVE_AMOUNT_WETH: bigint = 20n * 10n ** 18n; // 20 WETH
