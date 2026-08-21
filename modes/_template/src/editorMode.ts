import { DEFAULT_TUNING } from '@mp/character'
import { Hazard } from '@mp/components'
import type { ModeDescriptor } from '@mp/mode'
import { MARKER_COLORS } from '@mp/render-three'

import { STAND_OFFSET, TEMPLATE_REGISTRY, spawnOf, templateSession } from './rules'

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
  standOffset: STAND_OFFSET,
  /** One rule, one colour. The palette is shared so two games' hazards look alike; the mapping is each game's. */
  gizmos: { [Hazard.type]: MARKER_COLORS.hazard },
  spawn: spawnOf,
  session: templateSession,
}
