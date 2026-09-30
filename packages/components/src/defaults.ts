import { createRegistry } from './registry'
import { ENGINE_COMPONENTS } from './engine/index'
import { SHARED_COMPONENTS } from './shared/index'

/**
 * Every component this build knows about: what the engine reads, then the shared gameplay library.
 *
 * **Not what a game runs on.** A game composes its own registry from `ENGINE_COMPONENTS` plus whichever of
 * the shared rules it actually wants plus its own (ADR 0052) — this being the universal set was what made the
 * editor implicitly parkour, since every game was force-fed all four rules whether they meant anything to it.
 *
 * What it is still for: a *fallback* when nothing has said which game, which is a level naming a game this
 * build does not have, and a default for tests that do not care.
 *
 * Its own module so `index.ts` stays a re-export list, and so a test can build a registry of fakes without
 * importing this one.
 */
export const DEFAULT_REGISTRY = createRegistry([...ENGINE_COMPONENTS, ...SHARED_COMPONENTS])
