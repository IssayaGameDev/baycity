import { defineComponent, type ComponentDef } from '@mp/components'
import type { InputCommand } from '@mp/core'

import { DEFAULT_CURVE, type ProgressCurve } from './progression'

/**
 * A step is a tick of time holding a direction on the ground, at a fixed cadence (ADR 0081).
 *
 * Kodjo measured the game being cloned: facing a wall, pressing forward, no key going down and no animation
 * playing, Experience still climbed. Forty popups in ten seconds, and the same count at speed 10 and at speed
 * 100. Mid-air, nothing. So a "step" there is not a key struck, not a footfall, and not a distance — it is
 * **time spent holding a direction while grounded, at a fixed rate**, whether or not you actually move and
 * however fast you are set to.
 *
 * The keycaps still press. They are what you see; this is what you earn.
 */

/** Steps a second while holding a direction on the ground. Four, from Kodjo's count.  */
export const stepsPerSecond = (curve: ProgressCurve): number => Math.max(0, curve.stepsPerSecond)

/**
 * The steps one tick earns: grounded and a direction held, the tick's share of `stepsPerSecond`; otherwise
 * none. Pure — the component below is only the wiring to the tick.
 */
export const stepsThisTick = (grounded: boolean, cmd: Pick<InputCommand, 'moveX' | 'moveZ'>, curve: ProgressCurve, dt: number): number =>
  grounded && (cmd.moveX !== 0 || cmd.moveZ !== 0) ? stepsPerSecond(curve) * dt : 0

export interface StepperDeps {
  readonly curve: () => ProgressCurve
  /** Fractional steps this tick. The game accrues and pays out whole ones. */
  readonly onSteps?: (steps: number) => void
}

/**
 * The player component that turns held input into steps. Runs in the movement slot with the tick's input, which
 * is the one place a component can see what the player is pressing (ADR 0061).
 */
export const createStepper = (deps: StepperDeps): ComponentDef<Record<string, never>> =>
  defineComponent({
    type: 'Stepper',
    label: 'Stepper',
    attachesTo: 'player',
    singleton: true,
    params: {},
    onLocomote: (_self, ctx, cmd) => {
      const steps = stepsThisTick(ctx.character.grounded(), cmd, deps.curve(), ctx.dt)
      if (steps > 0) deps.onSteps?.(steps)
    },
  })

/** The same definition with nothing bound, for the registry — the shape `LOCOMOTION_DEF` uses. */
export const STEPPER_DEF: ComponentDef<Record<string, never>> = createStepper({ curve: () => DEFAULT_CURVE })
