import { Death, Hazard } from '@mp/components'
import { DEFAULT_TUNING, createLocomotion } from '@mp/humanoid'
import type { ModeDescriptor } from '@mp/mode'
import { MARKER_COLORS } from '@mp/render-three'

import { KEYBOARD_REGISTRY, keyboardSession, spawnOf, GAME_CURVE } from './rules'
import { createStepper } from './steps'
import { KEY_SETTINGS, keyboardGridOf } from './keycaps'
import { CURVE_SETTINGS } from './progression'
import { StepPad } from './stepPad'
import { Treadmill } from './treadmill'
import { WinsPad } from './wins'

/**
 * Keyboard Escape, as the tools see it (ADR 0052, ADR 0065).
 *
 * A clone of Roblox's `+1 Speed Keyboard Escape`, which is an **incremental simulator** wearing an obby's
 * clothes: every step earns Experience, Experience buys Levels, and a Level raises the speed cap. The tension
 * is that being fast also makes the character hard to steer.
 *
 * The game being cloned calls its currency "Speed". Here it is **Experience**, so that "speed" means the one
 * thing that is a velocity (ADR 0071).
 *
 * `registry` carries `Keyboard`, which is what makes a platform's top face a board of keys (ADR 0069), and
 * `WinsPad`, which ends a stage (ADR 0073). Nothing about the *look* of the keys is here: it is not a rule, not
 * level content and not something a tool needs, so it is wired in `main.ts` against `@mp/tps`'s scene handle.
 */
export const KEYBOARD_MODE: ModeDescriptor = {
  name: 'keyboard',
  label: 'Keyboard',
  registry: KEYBOARD_REGISTRY,
  /**
   * The **starting** tuning. `moveSpeed` here is what you run at before the first frame writes Max Speed into
   * the client's live copy (`client.tuning`, ADR 0071) — the client copies this object on the way in
   * (ADR 0057), so nothing written here after startup reaches the character.
   *
   * `groundAccelTime`, `groundStopTime` and `airControl` are times and ratios, so they scale with `moveSpeed`:
   * left alone, a character at 283 m/s steers exactly like one at 2.8 — total control, no momentum. The
   * ceilings (m/s², ADR 0078/0096) are what give it weight, and they are quoted at `ACCEL_REF_SPEED` and grow
   * with `√speed` from there, because a *fixed* ceiling cannot survive this game's hundredfold climb: at
   * Level 500 a fixed 60 would take 4.7 seconds and 667 metres to stop.
   *
   * Three of them, matching what Kodjo's collaborators measured off the genre: starting is instant at every
   * speed, stopping and turning carry inertia that grows with speed, and the air is hardest of all.
   *
   * - `groundMaxAccel` — `Infinity`: gaining speed is never limited, so a start is instant.
   * - `groundBrakeMaxAccel` — losing or redirecting it, which is a release and every turn.
   * - `airMaxAccel` — steering in the air.
   * - `airDrag` — and the air itself is not free: speed decays while airborne, stick or no stick (ADR 0107).
   *   A fraction per second, so the one number holds across the whole Level range.
   *
   * Tuned by feel on the Movement folder's sliders, which is the only place the numbers are written down:
   * a second copy in a doc is a copy that goes stale.
   */
  tuning: { ...DEFAULT_TUNING, groundMaxAccel: Infinity, groundBrakeMaxAccel: 200, airMaxAccel: 100, airDrag: 0.5 },
  /**
   * The palette is shared so two games' hazards look alike; the mapping is each game's own. A `WinsPad` is
   * where a stage ends, which is what the shared palette calls a goal.
   */
  gizmos: { [Hazard.type]: MARKER_COLORS.hazard, [WinsPad.type]: MARKER_COLORS.goal, [Treadmill.type]: MARKER_COLORS.checkpoint, [StepPad.type]: MARKER_COLORS.bumper },
  /**
   * The shipped locomotion, whose `moveSpeed` Level writes, and the **Stepper** that turns held input into the
   * steps Experience is paid for (ADR 0081). This list and `playerDefs` have to agree: a type listed here with no
   * definition is refused by the component runtime.
   */
  player: [
    { id: 'loco', type: 'Locomotion', params: {} },
    { id: 'stepper', type: 'Stepper', params: {} },
    { id: 'death', type: Death.type, params: {} },
  ],
  /** The editor's play-test carries the Stepper with nowhere to report to; `main.ts` binds the sink. */
  playerDefs: (host) => [createLocomotion(host), createStepper({ curve: () => GAME_CURVE, level: () => 0 })],
  /**
   * Where this game's keys land on a box face, so the editor can draw them before the level has run
   * (ADR 0120). The caps themselves are generated at load, which left an author placing platforms blind.
   */
  surfaceGrid: keyboardGridOf,
  // The progression curves and the key geometry, in one Game row (ADR 0087, ADR 0115).
  settings: { ...CURVE_SETTINGS, ...KEY_SETTINGS },
  spawn: spawnOf,
  session: keyboardSession,
}
