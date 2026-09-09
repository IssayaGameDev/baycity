import { DEFAULT_TUNING, createLocomotion } from '@mp/humanoid'
import { Death, Hazard } from '@mp/components'
import type { ModeDescriptor } from '@mp/mode'
import { MARKER_COLORS } from '@mp/render-three'

import { TEMPLATE_REGISTRY, spawnOf, templateSession } from './rules'

/**
 * The template game, as the platform sees it (ADR 0052) — and the whole of what a new game has to write.
 *
 * Copy `modes/_template` to `modes/<yours>`, rename the three identifiers below, and you have a running game
 * with the shared character controller, its procedural animation, the camera, netcode and the editor. The
 * client is `@mp/game-client` (ADR 0056); nothing here reaches into it.
 *
 * The directory is `_`-prefixed so the editor's game picker skips it: it exists to be copied, not authored
 * for. It also *is* the acceptance test for the shell — if `main.ts` cannot stay three lines, something that
 * belongs in a package has leaked back into a game.
 */
export const TEMPLATE_MODE: ModeDescriptor = {
  name: 'template',
  label: 'Template',
  registry: TEMPLATE_REGISTRY,
  // The shared Roblox-like feel (ADR 0012). A game with a different character overrides these.
  tuning: DEFAULT_TUNING,
  /** One rule, one colour. The palette is shared so two games' hazards look alike; the mapping is each game's. */
  gizmos: { [Hazard.type]: MARKER_COLORS.hazard },
  /**
   * The player's own components (ADR 0059, ADR 0061).
   *
   * `Locomotion` is the stack's `stepCharacter` wearing a component, which is what makes it **this game's
   * choice** rather than something every game runs. Kept here because it is the seam a new game is least likely to find on its own.
   *
   * `Death` is data the client reads: whether the rig falls apart, and the timing of it dropping back in.
   * Both default to exactly what the client hardcoded, so declaring them changed nothing.
   */
  player: [
    { id: 'loco', type: 'Locomotion', params: {} },
    { id: 'death', type: Death.type, params: {} },
  ],
  /**
   * Built per session, closing over the live character (ADR 0061) — it does not exist when the registry is.
   * A game with its own movement returns its own definition here and the platform is none the wiser.
   */
  playerDefs: (host) => [createLocomotion(host)],
  /**
   * Where a player starts, and this game's rules — both read by the client *and* by the editor's play-test,
   * which is why they are fields here rather than arguments in `main.ts` (ADR 0065).
   */
  spawn: spawnOf,
  session: templateSession,
}
