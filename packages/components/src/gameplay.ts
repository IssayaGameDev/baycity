import { TRACK } from '@mp/content'
import { defineComponent } from './define'

/**
 * Gameplay rules and motion — what a **mode** reads. The loader never looks at these.
 *
 * Three of them **own their own reaction** since stage C2: `onContact` fires when a collider on the same node
 * is touched, and the mode supplies only what dying and making progress mean for it (`Effects`). The branches
 * that used to sit in `modes/parkour/src/main.ts` are gone.
 *
 * `Goal` has no hook, because the mode has no goal rule — nothing ends a run yet, and writing one here would
 * be a design decision wearing an implementation's clothes.
 *
 * `Track` has no hook either, and that is not an omission: the loader's frame tree evaluates it as a pure
 * function of the synced clock, so a late joiner needs no catch-up and a static subtree costs nothing. An
 * accumulating hook would trade both away for nothing.
 *
 * A rule fires on **contact with any `Collider` on the same node**, no wiring between the two. That is
 * Unity's model: the contact is delivered to the node and every component on it hears about it. The
 * rejected alternative — a rule holding a pointer to its collider — has a dangling state this cannot have.
 *
 * The rules are `singleton` because a second copy on one node is redundant rather than expressive (two
 * hazards kill once; two bumpers resolve to the stronger, which is the same as deleting the weaker).
 * Colliders are the repeatable ones. Reversible if a rule ever grows a per-copy parameter that stacks.
 */

/** Touching it saves this as the respawn point. Ordered by tree walk, which is what indexes them. */
export const Checkpoint = defineComponent({
  type: 'Checkpoint',
  params: {},
  singleton: true,
  // The node, not an index: what counts as progress is the mode's business, and it is the mode that holds the
  // ordered list a saved index means anything against.
  onContact: (_self, ctx, hit) => ctx.effects.progress(hit.node),
})

/** Touching it completes the level. No hook: the mode has no goal rule yet. */
export const Goal = defineComponent({
  type: 'Goal',
  params: {},
  singleton: true,
})

/** Touching it kills. Distinct from falling past the level's `fallY`, which is config, not a component. */
export const Hazard = defineComponent({
  type: 'Hazard',
  params: {},
  singleton: true,
  onContact: (_self, ctx) => ctx.effects.kill(),
})

/**
 * Launches whatever lands on it.
 *
 * `power` is an upward speed in m/s, replacing the character's vertical velocity. Apex is
 * `power² / (2·gravity)`; at the tuned gravity of 55 a jump leaves the ground at `√(2·55·3) ≈ 18.2` m/s,
 * so **anything below 18 throws you lower than your own jump**. 26 gives about 6.1 m, roughly twice a
 * jump (ADR 0032).
 *
 * The default lives here rather than in the editor, which is where `DEFAULT_BUMPER_POWER` sat: a schema
 * value defaulted by the tool means hand-written JSON has no default at all.
 */
export const Bumper = defineComponent({
  type: 'Bumper',
  params: {
    power: { kind: 'number', default: 26, min: 1, max: 60, step: 1, label: 'launch (m/s)' },
  },
  singleton: true,
  /**
   * `self.params.power` is a `number` here with no cast and no lookup — the payoff of declaring parameters.
   *
   * The request goes through the character's `launch` field rather than onto `vy`, because leaving a surface
   * is five decisions in `stepCharacter` and not one (ADR 0032). `CharacterAccess.launch` keeps the strongest
   * request in a tick, so a stack of bumpers throws you as hard as the hardest one.
   */
  onContact: (self, ctx) => ctx.character.launch(self.params.power),
})

/**
 * Clock-driven keyed motion — a pure function of synced time, so no per-object networking (ADR 0013/0021,
 * ADR 0029). **Offsets** the node's local pose per channel rather than replacing it (ADR 0050).
 *
 * The motion comes from one of two places, and both are supported on purpose (ADR 0050):
 *
 * - `keys` — this node's own track. What a one-off mover wants: no file, nothing shared.
 * - `clip` — an animation asset every user of it shares. Edit the clip, every platform playing it changes.
 *
 * **Inline keys win** when a file somehow has both; the editor keeps them exclusive. Duration is the last
 * key's `t`, derived rather than stored so the two cannot disagree.
 *
 * `loop` and `phaseMs` stay here rather than moving into the clip, because they are per-placement: a
 * staggered row of pistons is one clip and six phases.
 */
export const Track = defineComponent({
  type: TRACK,
  params: {
    clip: { kind: 'asset', of: 'animation', default: '', label: 'clip' },
    keys: { kind: 'keys', clip: 'clip' },
    loop: { kind: 'enum', options: ['loop', 'pingPong', 'once'], default: 'loop' },
    phaseMs: { kind: 'number', default: 0, step: 50, label: 'phase (ms)' },
  },
  singleton: true,
})

/**
 * What dying looks like — the reaction, not the rule (ADR 0059).
 *
 * The rule is already a component: a `Hazard` fires `effects.kill` and the game's session decides whether
 * that counts. What was left hardcoded in the shared game client was everything *after* that: the rig falls
 * apart into loose bodies, you wait for a click, and the body drops back in two parts at a time on a fixed
 * timing. Every game got the same one whether it suited them or not.
 *
 * **Data, with no hooks**, and read by the client — the same arrangement as `Collider` and `Renderer`, which
 * are components the *loader* reads. It has to be: a ragdoll is ten dynamic Rapier bodies and ten Three
 * meshes built from the rig's live pose, so a headless component cannot produce one. It does not need to —
 * the client already knows the death happened, and what it was missing was the game's opinion about it.
 *
 * **On the player**, so it is declared by the game rather than dragged onto a platform.
 *
 * Its defaults are exactly what the client hardcoded, so a game that says nothing dies the way it always did.
 */
export const Death = defineComponent({
  type: 'Death',
  label: 'Death reaction',
  attachesTo: 'player',
  singleton: true,
  params: {
    /**
     * Break the rig into loose bodies on death. Off leaves the body where it fell and skips straight to the
     * wait — which is what a game whose character is not a jointed figure wants.
     */
    ragdoll: { kind: 'bool', default: true },
    /** Seconds between each pair of parts arriving as the body reassembles. */
    assembleStagger: { kind: 'number', default: 0.05, min: 0, max: 0.4 },
    /** Seconds a part takes to fall into place. */
    assembleFall: { kind: 'number', default: 0.18, min: 0.02, max: 1 },
    /** Metres above its final position a part starts from. */
    assembleHeight: { kind: 'number', default: 2.5, min: 0.2, max: 8 },
  },
})

export const GAMEPLAY_COMPONENTS = [Checkpoint, Goal, Hazard, Bumper, Track]

/**
 * Components a game puts on its **player** rather than in a level (ADR 0059).
 *
 * Separate from `GAMEPLAY_COMPONENTS` because the two are offered in different places: those go in the
 * editor's Add Component menu, these go in a `ModeDescriptor.player` list. A game still has to list them in
 * its registry, which is what validates their parameters.
 */
export const PLAYER_COMPONENTS = [Death]
