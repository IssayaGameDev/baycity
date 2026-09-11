import { defineComponent, type ComponentDef } from '@mp/components'
import type { InputCommand } from '@mp/core'

import { DEFAULT_CURVE, stepsPerMinute, type ProgressCurve } from './progression'

/**
 * A step is a tick of time holding a direction, at a cadence set by your Level (ADR 0081).
 *
 * Kodjo measured the game being cloned: facing a wall, pressing forward, no key going down and no animation
 * playing, Experience still climbed. The speed setting made no difference. So a "step" there is not a key
 * struck, not a footfall, and not a distance — it is **time spent holding a direction**, whether or not you
 * actually move, on the ground or in the air (Kodjo's call, overriding an earlier mid-air reading). The cadence is not fixed either: a table of eight levels put it
 * at 240 a minute to level 20, climbing to 600 from level 170 (`stepsPerMinute`).
 *
 * The keycaps still press. They are what you see; this is what you earn.
 */

/** Steps a second while holding a direction on the ground, at this Level. */
export const stepsPerSecond = (level: number, curve: ProgressCurve): number => stepsPerMinute(level, curve) / 60

/**
 * The steps one tick earns: a direction held, the tick's share of `stepsPerSecond`; otherwise none. Ground or
 * air alike. Pure — the component below is only the wiring to the tick.
 */
export const stepsThisTick = (cmd: Pick<InputCommand, 'moveX' | 'moveZ'>, level: number, curve: ProgressCurve, dt: number): number =>
  cmd.moveX !== 0 || cmd.moveZ !== 0 ? stepsPerSecond(level, curve) * dt : 0

export interface StepperDeps {
  readonly curve: () => ProgressCurve
  /** The player's Level now, which sets the cadence. */
  readonly level: () => number
  /** Fractional steps this tick. The game accrues and pays out whole ones. */
  readonly onSteps?: (steps: number) => void
}

/**
 * The player component that turns held input into steps. Runs in the movement slot with the tick's input, which
 * is the one place a component can see what the player is pressing (ADR 0061). Ground is not consulted.
 */
export const createStepper = (deps: StepperDeps): ComponentDef<Record<string, never>> =>
  defineComponent({
    type: 'Stepper',
    label: 'Stepper',
    attachesTo: 'player',
    singleton: true,
    params: {},
    onLocomote: (_self, ctx, cmd) => {
      const steps = stepsThisTick(cmd, deps.level(), deps.curve(), ctx.dt)
      if (steps > 0) deps.onSteps?.(steps)
    },
  })

/** The same definition with nothing bound, for the registry — the shape `LOCOMOTION_DEF` uses. */
export const STEPPER_DEF: ComponentDef<Record<string, never>> = createStepper({ curve: () => DEFAULT_CURVE, level: () => 0 })
