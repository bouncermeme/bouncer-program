/*
  The tick grid, straight from the pinned contract (contract/constants.ts,
  INTERFACE v0.29). Nothing here is retyped: the table, the bounds and the
  arithmetic are the generated module's, re-exported under the names the site
  uses.

  2,407 ticks starting at the launch's floor_value (tick 0): 0.25 percent
  apart up to tick 1845, the first at or above 100 times the floor
  (GRID_FINE_TICKS), then 1 percent apart, to the same top as 0.28's 1,024
  one-percent ticks. Ticks are multipliers on the value of the whole float,
  never on a per token price. A price is always value / float. Tick 2406
  (MAX_TICK) is the top of the grid and the interface's "no limit" bid.
*/

import { gridTop, MAX_FLOOR_VALUE, MAX_TICK, MIN_FLOOR_VALUE, MULT, SCALE_BITS, TICK_COUNT, tickForMaxValue, validateFloorValue, valueAtTick } from "@contract/constants";

export { gridTop, MAX_FLOOR_VALUE, MAX_TICK, MIN_FLOOR_VALUE, MULT, SCALE_BITS, TICK_COUNT, tickForMaxValue, validateFloorValue, valueAtTick };

/* Highest tick whose float value is at or below `value`, or 0 when even the floor is above it. The slider's snap; tickForMaxValue asks the same question and answers null under the floor. */
export function highestTickAtOrBelow(floorValue: bigint, value: bigint): number {
  return tickForMaxValue(floorValue, value) ?? 0;
}

/* The multiplier at a tick as a plain number, for display only. */
export function multiplierAtTick(tick: number): number {
  const m = MULT[tick];
  if (m === undefined) throw new RangeError("tick out of range");
  return Number(m) / 2 ** Number(SCALE_BITS);
}
