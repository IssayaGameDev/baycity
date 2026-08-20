import { createRegistry } from './registry'
import { ENGINE_COMPONENTS } from './engine'
import { GAMEPLAY_COMPONENTS } from './gameplay'

/**
 * Every component this build knows about, in the order the editor's add menu lists them: what the engine
 * reads first, then what a mode reads.
 *
 * Its own module so `index.ts` stays a re-export list, and so a test can build a registry of fakes without
 * importing this one.
 */
export const DEFAULT_REGISTRY = createRegistry([...ENGINE_COMPONENTS, ...GAMEPLAY_COMPONENTS])
