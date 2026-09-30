import { defineComponent } from '../define'

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
