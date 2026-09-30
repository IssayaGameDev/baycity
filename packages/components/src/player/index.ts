import { Death } from './death'

/**
 * Components a game puts on its **player** rather than in a level (ADR 0059).
 *
 * Separate from `SHARED_COMPONENTS` because the two are offered in different places: those go in the
 * editor's Add Component menu, these go in a `ModeDescriptor.player` list. A game still has to list them in
 * its registry, which is what validates their parameters.
 */
export const PLAYER_COMPONENTS = [Death]
