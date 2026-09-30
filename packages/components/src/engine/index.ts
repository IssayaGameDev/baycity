import { Collider } from './collider'
import { Light } from './light'
import { MaterialOverride } from './materialOverride'
import { Renderer } from './renderer'
import { Spawn } from './spawn'

/**
 * The engine's own components — the ones the **loader** reads to build a world, one per file. The shared rules
 * live in `../shared/` and are read by a game instead.
 *
 * Unity draws the same line: `Collider` and `MeshRenderer` are engine types, not user scripts, and no
 * amount of component system makes them optional.
 *
 * The type names come from `@mp/content`, which is where the loader reads them: one spelling, so a rename
 * cannot leave the engine looking for a component nobody registers.
 */
export const ENGINE_COMPONENTS = [Collider, Renderer, MaterialOverride, Spawn, Light]
