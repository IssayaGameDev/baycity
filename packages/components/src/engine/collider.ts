import { COLLIDER } from '@mp/content'
import { defineComponent } from '../define'

/**
 * One collision shape, at an offset from the node's transform.
 *
 * **Repeatable**, which is the whole reason a node holds a list: a ramp with a lip, or a bumper pad with a
 * separate rim, was two `Piece`s before and is one node with two colliders now.
 *
 * `center` is what makes that worth having. Without an offset, a second collider sits exactly on the first and
 * is the same collider twice — so repeatability would be a claim rather than a feature. It is Unity's
 * `BoxCollider.center`, it defaults to the origin, and every migrated piece leaves it there.
 */
export const Collider = defineComponent({
  type: COLLIDER,
  menu: 'Physics',
  params: {
    shape: { kind: 'collider', default: { kind: 'box', halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } },
    center: { kind: 'vec3', default: { x: 0, y: 0, z: 0 }, label: 'center' },
    /**
     * **Trigger**: detected on overlap, with no collision response (ADR 0054). Unity's `isTrigger`, Rapier's
     * sensor.
     *
     * Off by default, so every collider authored before this is unchanged. On, the shape stops being solid
     * entirely — it is not walked into, not stood on, and does not block the camera — but a rule on the same
     * node still fires when the character is inside it. That is what a kill plane wants, and what a solid
     * collider could not express: you would land on the thing meant to be empty space.
     */
    trigger: { kind: 'bool', default: false, label: 'trigger' },
    /**
     * Grip (ADR 0229, 0230): Rapier's friction, which a loose object slides by — and the player too, whose speeding up
     * and braking scale with it below 0.5 (never under a tenth while pushing a direction), and whom a slippery slope
     * pulls down. 0.5 is the grip every surface had before, so nothing authored changes; above it, a player grips no
     * better than that.
     */
    friction: { kind: 'number', default: 0.5, min: 0, max: 2, step: 0.05, label: 'friction', when: { param: 'trigger', is: [false] } },
    /** Bounciness, 0 to 1 (ADR 0229): the share of a landing's speed that throws a player or an object back up. */
    bounciness: { kind: 'number', default: 0, min: 0, max: 1, step: 0.05, label: 'bounciness', when: { param: 'trigger', is: [false] } },
  },
})
