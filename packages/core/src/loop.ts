/**
 * Fixed-timestep loop. The pure accumulator (`createStepper`) is separated from
 * the wall-clock runner (`startFixedLoop`) so the stepping logic is unit-testable
 * without timers.
 */

export interface Stepper {
  /** Add elapsed real time (ms); returns how many fixed steps to run now. */
  push: (elapsedMs: number) => number
  /** Time accumulated but not yet consumed by a step (ms). */
  pending: () => number
}

/**
 * Pure fixed-timestep accumulator. Clamps to `maxSteps` and drops the backlog
 * when far behind, avoiding the "spiral of death" after a long stall.
 */
export const createStepper = (fixedDtMs: number, maxSteps = 5): Stepper => {
  if (fixedDtMs <= 0) throw new Error('fixedDtMs must be > 0')
  let acc = 0
  return {
    push: (elapsedMs) => {
      acc += elapsedMs
      let steps = Math.floor(acc / fixedDtMs)
      if (steps <= 0) return 0
      if (steps > maxSteps) {
        acc = 0 // drop backlog
        return maxSteps
      }
      acc -= steps * fixedDtMs
      return steps
    },
    pending: () => acc,
  }
}

export interface LoopHandle {
  stop: () => void
  /**
   * Run every tick that is due, now (ADR 0140). Called at the start of each drawn frame, so a frame is never
   * drawn a tick behind because the timer fired late. The timer keeps running regardless, which is what keeps
   * the simulation going in a hidden tab, where frames stop.
   */
  pump: () => void
  /**
   * How far the loop is into its next tick, `[0, 1]`, read off its own accumulator — the fraction to
   * render-interpolate by (ADR 0140).
   *
   * From the **schedule**, not from when a tick happened to run. A timer fires a few milliseconds late, by a
   * different amount each time; interpolating by time since the tick *ran* put every drawn frame off by that
   * lateness times the speed of whatever was drawn, which is the shake riders saw on moving platforms.
   */
  alpha: () => number
}

/**
 * Wall-clock fixed-timestep loop. Uses `performance.now` + `setTimeout` (both
 * available headless in Node and in the browser). `onTick` receives the fixed
 * step in seconds and a monotonically increasing tick index. `now` is injectable
 * for tests.
 */
export const startFixedLoop = (opts: {
  tickRateHz: number
  onTick: (fixedDtSeconds: number, tickIndex: number) => void
  maxStepsPerWake?: number
  now?: () => number
}): LoopHandle => {
  const fixedDtMs = 1000 / opts.tickRateHz
  const fixedDtSeconds = fixedDtMs / 1000
  const now = opts.now ?? (() => performance.now())
  const stepper = createStepper(fixedDtMs, opts.maxStepsPerWake ?? 5)
  let tickIndex = 0
  let last = now()
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  /** Every tick the time since `last` owes, whoever asked: the timer or a frame. */
  const run = (): void => {
    const at = now()
    const steps = stepper.push(at - last)
    last = at
    for (let i = 0; i < steps; i++) opts.onTick(fixedDtSeconds, tickIndex++)
  }

  const wake = (): void => {
    if (stopped) return
    run()
    const delay = Math.max(0, fixedDtMs - stepper.pending())
    timer = setTimeout(wake, delay)
  }

  timer = setTimeout(wake, fixedDtMs)

  return {
    stop: () => {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
    pump: () => {
      if (!stopped) run()
    },
    alpha: () => Math.min(1, Math.max(0, (stepper.pending() + (now() - last)) / fixedDtMs)),
  }
}
