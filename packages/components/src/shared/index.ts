import { ComponentError } from '../params'
import type { AnyComponentDef } from '../registry'
import { Boss } from './boss'
import { Bumper } from './bumper'
import { Checkpoint } from './checkpoint'
import { Hazard } from './hazard'
import { Sequence } from './sequence'

/**
 * The shared components: rules any game can use as they are, one per file. A game's own components live in its
 * folder, `modes/<game>/src/components/`.
 *
 * A rule fires on **contact with any `Collider` on the same node**, no wiring between the two. That is
 * Unity's model: the contact is delivered to the node and every component on it hears about it. The
 * rejected alternative — a rule holding a pointer to its collider — has a dangling state this cannot have.
 * The rule supplies the reaction; the game supplies what dying and making progress mean for it (`Effects`).
 *
 * The rules are `singleton` because a second copy on one node is redundant rather than expressive (two
 * hazards kill once; two bumpers resolve to the stronger, which is the same as deleting the weaker).
 * Colliders are the repeatable ones. Reversible if a rule ever grows a per-copy parameter that stacks.
 */
export const SHARED_COMPONENTS = [Checkpoint, Hazard, Bumper, Sequence, Boss]

/**
 * The components every game *could* have, looked up by name (ADR 0077).
 *
 * A game's registry is code plus data: its own components are code (`Keyboard`, `WinsPad`), and the shared
 * ones it has opted into — `Bumper`, `Checkpoint`, `Hazard`, `Sequence`, `Boss` — are a list of names in
 * `content/<game>/game.json`. The list is data so the **editor can append to it**: placing a trampoline into a
 * game that has no `Bumper` adds `Bumper` to that game, rather than refusing, or crashing the game at load.
 *
 * Only these are addable that way, because only these ship in every build. Another game's private component
 * cannot be adopted — its code is not in this game — and the editor says so instead.
 */
const SHARED_BY_TYPE: ReadonlyMap<string, AnyComponentDef> = new Map(SHARED_COMPONENTS.map((d) => [d.type, d]))

/** Every shared component, by type, sorted — what a picker can offer a game that lacks one. */
export const SHARED_COMPONENT_TYPES: readonly string[] = [...SHARED_BY_TYPE.keys()].sort()

export const isSharedComponent = (type: string): boolean => SHARED_BY_TYPE.has(type)

/**
 * Resolve a game's data list to definitions. Throws on a name that is not a shared component: a data file
 * naming something the build cannot supply is a broken file, and a registry silently missing a type is exactly
 * the failure mode this exists to end.
 */
export const sharedComponents = (types: readonly string[]): AnyComponentDef[] =>
  types.map((type) => {
    const def = SHARED_BY_TYPE.get(type)
    if (def === undefined) throw new ComponentError(`game.json: '${type}' is not a shared component (one of ${SHARED_COMPONENT_TYPES.join(', ')})`)
    return def
  })
