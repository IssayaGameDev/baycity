import { startTpsClient } from '@mp/tps'

import { SWING_MODE } from './editorMode'
import { DEFAULT_ROPE, type RopeTuning } from './rope'
import { drawRopes } from './ropeView'
import { createSwing, newSwingState, SWINGING_STATE } from './swing'

/**
 * Swing, as an application (ADR 0067).
 *
 * The first game on the platform to be more than the shipped one, and the file where that shows. Three things
 * are wired here that `startTpsClient` knows nothing about:
 *
 * 1. **The swing replaces `Locomotion`** (ADR 0061). `stepCharacter` still runs every tick — it is what
 *    supplies the gravity that drives the pendulum — but this game owns the slot around it, which is where the
 *    rope's force is added and where the stick is taken from air control and given to the pump.
 * 2. **The rope is drawn per rendered frame** (ADR 0066), because it hangs off a hand animated per frame.
 * 3. **Its feel is a folder on the debug pane** (ADR 0018), because nobody sets a stiffness by argument.
 *
 * Not one field was added to `TpsClientOptions` or `ModeDescriptor` for any of it, which is the claim ADR 0065
 * and ADR 0066 made and this file is the test of.
 */
const state = newSwingState()
/** Allocated once: `playerStates` is asked every outgoing message, thirty times a second. */
const EMPTY: ReadonlySet<string> = new Set()
const SWINGING: ReadonlySet<string> = new Set([SWINGING_STATE])
/** Live, and bound to the pane below — one object, so a slider and the sim cannot disagree (ADR 0057). */
const rope: RopeTuning = { ...DEFAULT_ROPE }

const client = await startTpsClient({
  ...SWING_MODE,
  // The game builds its own player definitions, so this closes over `state` and `rope` (ADR 0061). No
  // `createLocomotion` here: the swing *is* this game's locomotion.
  playerDefs: (host) => [createSwing({ host, state, tuning: () => rope })],
  /**
   * One bit, so other players can see a rope at all (ADR 0068).
   *
   * The anchor itself is **not** sent: it is a position and the wire carries no game-defined positions, so each
   * viewer re-runs the same search from where it drew the swinging player. This bit is what tells it when to.
   * Free — bits 3..7 of the flags byte were already being transmitted (ADR 0064).
   */
  states: [SWINGING_STATE],
  playerStates: () => (state.rope === null ? EMPTY : SWINGING),
})

drawRopes(client, state, () => rope)

const folder = client.debugPane.addFolder({ title: 'Swing' })
folder.addBinding(rope, 'stiffness', { min: 10, max: 300, step: 1, label: 'stiffness' })
folder.addBinding(rope, 'damping', { min: 0, max: 30, step: 0.5, label: 'damping' })
folder.addBinding(rope, 'pump', { min: 0, max: 40, step: 0.5, label: 'pump m/s²' })
folder.addBinding(rope, 'minLength', { min: 1, max: 20, step: 0.5, label: 'min length m' })
folder.addBinding(rope, 'maxLength', { min: 2, max: 40, step: 0.5, label: 'max length m' })
folder.addBinding(rope, 'coneDeg', { min: 10, max: 170, step: 1, label: 'search cone °' })
folder.addBinding(rope, 'riseDeg', { min: 0, max: 80, step: 1, label: 'min rise °' })
