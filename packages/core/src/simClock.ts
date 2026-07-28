/**
 * Simulation clock for clock-driven content.
 *
 * Clock-driven pieces (moving/rotating platforms) are a pure function of time, so every
 * client derives the same pose with no networking — but only if the time they are fed
 * advances **one fixed step per fixed step**. Reading the wall clock inside the tick does
 * not: `startFixedLoop` can run several ticks in one wake, and within a wake the wall clock
 * barely moves, so the first sub-step gets the whole elapsed delta and the rest get ~zero.
 * A character advancing a full `dt` every sub-step then slides against the platform and is
 * yanked back next wake (visible as jitter, and worse the faster the platform).
 *
 * So: advance by exactly `tickMs` per tick, and stay locked to `reference` (the synced
 * server clock) by *slewing* — nudging by at most `maxSlewMsPerTick`, small enough that the
 * per-tick delta is still ~`tickMs`. A gap too large to slew away (a backgrounded tab) is
 * snapped. Cross-client agreement is bounded by the slew band, not by timer accuracy.
 */
export interface SimClock {
  /** Advance one fixed step and return this step's simulation time (ms). */
  tick: () => number
  /** Current simulation time (ms) without advancing — for render interpolation. */
  now: () => number
}

export interface SimClockOptions {
  /** Fixed step length (ms) — the same step the simulation advances by. */
  tickMs: number
  /** Authoritative time to track (ms), e.g. a clock-synced `serverNow`. */
  reference: () => number
  /**
   * Cap on the per-tick correction (ms). Defaults to 5% of `tickMs`, which absorbs a sustained
   * 5% rate mismatch between the loop and the reference — enough that ordinary jitter and
   * dropped backlog never accumulate into a hard resync — while keeping every step within 5% of
   * nominal. Riders are placed from the platform's pose rather than a per-tick delta, so a
   * slightly uneven platform speed does not show up as slip on anything standing on it.
   */
  maxSlewMsPerTick?: number
  /** Drift beyond this (ms) is snapped rather than slewed (tab stall, clock re-sync). */
  resyncThresholdMs?: number
}

export const createSimClock = (opts: SimClockOptions): SimClock => {
  const maxSlew = opts.maxSlewMsPerTick ?? opts.tickMs * 0.05
  const resync = opts.resyncThresholdMs ?? 500
  let t: number | null = null // null until the first tick anchors it

  return {
    tick: () => {
      if (t === null) {
        t = opts.reference()
        return t
      }
      t += opts.tickMs
      const drift = opts.reference() - t
      if (Math.abs(drift) > resync) t = opts.reference()
      else t += Math.max(-maxSlew, Math.min(maxSlew, drift))
      return t
    },
    now: () => t ?? opts.reference(),
  }
}
