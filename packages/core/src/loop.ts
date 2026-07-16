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
}

/**
 * Wall-clock fixed-timestep loop. Uses `performance.now` + `setTimeout` (both
 * available headless in Node and in the browser). `onTick` receives the fixed
 * step in seconds and a monotonically increasing tick index.
 */
export const startFixedLoop = (opts: {
  tickRateHz: number
  onTick: (fixedDtSeconds: number, tickIndex: number) => void
  maxStepsPerWake?: number
}): LoopHandle => {
  const fixedDtMs = 1000 / opts.tickRateHz
  const fixedDtSeconds = fixedDtMs / 1000
  const stepper = createStepper(fixedDtMs, opts.maxStepsPerWake ?? 5)
  let tickIndex = 0
  let last = performance.now()
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const wake = (): void => {
    if (stopped) return
    const now = performance.now()
    const steps = stepper.push(now - last)
    last = now
    for (let i = 0; i < steps; i++) opts.onTick(fixedDtSeconds, tickIndex++)
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
  }
}
