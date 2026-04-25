/**
 * Uniswap V3 tick math utilities.
 *
 * Ticks are defined such that price = 1.0001^tick.
 * Valid tick range is [-887272, 887272]. Ticks must be multiples of the pool's
 * tickSpacing (which depends on the fee tier).
 *
 * References:
 *   - Uniswap V3 whitepaper §6
 *   - TickMath.sol (MIN_TICK/MAX_TICK constants)
 */

/** Smallest tick allowed by Uniswap V3. */
export const MIN_TICK = -887_272;

/** Largest tick allowed by Uniswap V3. */
export const MAX_TICK = 887_272;

/** Convert a positive price to the nearest (floor) Uniswap V3 tick. */
export function priceToTick(price: number): number {
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error('priceToTick: price must be a positive finite number');
  }
  return Math.floor(Math.log(price) / Math.log(1.0001));
}

/** Convert a tick to a price. */
export function tickToPrice(tick: number): number {
  if (!Number.isInteger(tick)) {
    throw new Error('tickToPrice: tick must be an integer');
  }
  if (tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error(`tickToPrice: tick ${tick} outside [${MIN_TICK}, ${MAX_TICK}]`);
  }
  return Math.pow(1.0001, tick);
}

/** Align a tick DOWN to the nearest multiple of `spacing` (floor). */
export function alignTickFloor(tick: number, spacing: number): number {
  if (spacing <= 0 || !Number.isInteger(spacing)) {
    throw new Error('alignTickFloor: spacing must be a positive integer');
  }
  // Math.floor handles negatives correctly for our intent (round towards -∞).
  return Math.floor(tick / spacing) * spacing;
}

/** Align a tick UP to the nearest multiple of `spacing` (ceil). */
export function alignTickCeil(tick: number, spacing: number): number {
  if (spacing <= 0 || !Number.isInteger(spacing)) {
    throw new Error('alignTickCeil: spacing must be a positive integer');
  }
  return Math.ceil(tick / spacing) * spacing;
}

/** Clamp a tick to Uniswap V3's valid range. */
export function clampTick(tick: number): number {
  if (tick < MIN_TICK) return MIN_TICK;
  if (tick > MAX_TICK) return MAX_TICK;
  return tick;
}
