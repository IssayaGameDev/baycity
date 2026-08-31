import { defineComponent, type ComponentDef } from '@mp/components'
import { DEFAULT_TUNING, stepCharacter, type CharacterState, type CharacterTuning, type PlatformPoseLookup } from './groundController'

/**
 * The stack's locomotion, as a component a game attaches (ADR 0061).
 *
 * `stepCharacter` was one function every game ran. `ModeDescriptor.tuning` let a game change its *numbers*,
 * and nothing let a game change its *mechanics* — so a second game could be faster or floatier and could not
 * be a different kind of game. A 2D platformer, a racer, anything with a dash: none of them were expressible.
 *
 * **A move, not a rewrite.** `stepCharacter` stays exactly the function it was, with its 119 tests, and this
 * calls it. What changes is who decides to call it: a game that wants this locomotion attaches this component,
 * and a game that wants its own writes its own and attaches that instead. Nothing is shared by default.
 *
 * **Built by the game, not by the platform.** A factory rather than a constant, because the deps are a
 * *session's* — the character does not exist until a level is joined. The game builds the definition with them
 * closed over, so the platform never learns what a locomotion component needs and `Ctx` does not grow a field
 * per capability. A game whose locomotion needs something else entirely closes over that instead.
 *
 * **No parameters, deliberately.** The obvious move is to make `CharacterTuning` this component's params, and
 * it is wrong today: the debug pane is bound to the mode's live `tuning` object, so params would be a second
 * source for the same fourteen numbers and they would drift — which is the exact failure ADR 0057 exists to
 * have fixed once. Tuning arrives through `deps` as the one source it already is. Moving it into params is a
 * migration of its own, and it needs the runtime to expose a live instance's params first.
 */

/** What this locomotion needs from a session. Getters, because none of it exists when the registry is built. */
export interface LocomotionDeps {
  /** The live character. Read every tick, so a session that replaces it is followed. */
  readonly character: () => CharacterState | null
  /** The feel. A getter, so the debug pane's sliders stay live — it is the mode's own object. */
  readonly tuning: () => CharacterTuning
  /**
   * Where the clock-driven pieces are this tick, so a rider is carried. `undefined` with no level loaded,
   * which is what `stepCharacter` already accepts.
   */
  readonly platforms?: () => PlatformPoseLookup | undefined
}

/**
 * Build the locomotion component for a game.
 *
 * `type` is a parameter so a game can name its own: two games with different locomotion both showing as
 * `Locomotion` in a registry would be two different things wearing one name.
 */
export const createLocomotion = (deps: LocomotionDeps, type = 'Locomotion'): ComponentDef<Record<string, never>> =>
  defineComponent({
    type,
    label: 'Locomotion',
    attachesTo: 'player',
    singleton: true,
    params: {},
    /**
     * The movement slot — between the host's two physics half-steps, which is what lets the character resolve
     * against where the platforms are *now* rather than where they were last tick.
     */
    onLocomote: (_self, ctx, cmd) => {
      const char = deps.character()
      if (char === null) return
      stepCharacter(char, cmd, ctx.dt, deps.tuning(), deps.platforms?.())
    },
  })

/**
 * The same definition with **nothing bound**, for a game's registry.
 *
 * A registry is built once at module load and is what a tool validates parameters against; the session's
 * definition is the one that actually runs (`PlayerEntity.defs`). Only the closure differs, so the two cannot
 * meaningfully drift — and a registry that lists everything the game uses is the point of having one.
 *
 * Its `onLocomote` returns immediately, having no character, which is what a tool wants anyway.
 */
export const LOCOMOTION_DEF: ComponentDef<Record<string, never>> = createLocomotion({
  character: () => null,
  tuning: () => DEFAULT_TUNING,
})
