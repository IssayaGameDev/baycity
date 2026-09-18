import { vec3 } from '@mp/core'
import { THREE } from '@mp/render-three'
import { describe, expect, it } from 'vitest'

/**
 * Which pose a reparent re-expresses (ADR 0126).
 *
 * Dragging a node onto a new parent keeps its world pose, and the editor computes the new local transform off
 * the **scene graph** — `parent⁻¹ · child`, where the composed matrices already live. That is the right place
 * to read it from and the wrong pose to read: the groups hold the authored transform **plus** whatever the
 * movers contribute, while the preview clock runs and also at rest for any mover with a phase `offset`, which
 * is drawn partway along its travel.
 *
 * So the reparent wrote the animation's current position into the file, permanently. Every other write path
 * subtracts the offset (`motionOffsetAt`); this one cannot, because the offset is in the old parent's frame
 * and the value being computed is in the new one. It reads the authored poses instead.
 *
 * `localInside` lives in `main.ts` with the scene, so its arithmetic is reproduced here — what is being pinned
 * is which pose goes in, and that the two answers genuinely differ.
 */

/** `main.ts`'s `localInside`: the local transform `child` needs to keep its world pose under `parent`. */
const localInside = (child: THREE.Object3D, parent: THREE.Object3D | null): THREE.Vector3 => {
  child.updateWorldMatrix(true, false)
  parent?.updateWorldMatrix(true, false)
  const m = new THREE.Matrix4()
  if (parent === null) m.copy(child.matrixWorld)
  else m.copy(parent.matrixWorld).invert().multiply(child.matrixWorld)
  const position = new THREE.Vector3()
  m.decompose(position, new THREE.Quaternion(), new THREE.Vector3())
  return position
}

/** The authored transform, and the offset a mover contributes at the clock the preview is showing. */
const AUTHORED = vec3(1, 2, 3)
const MOTION = vec3(0, 7, 0)

/** Two candidate new parents: the level root, and a group that is itself moved. */
const scene = (): { root: THREE.Group; newParent: THREE.Group; child: THREE.Group } => {
  const root = new THREE.Group()
  const oldParent = new THREE.Group()
  oldParent.position.set(10, 0, 0)
  const newParent = new THREE.Group()
  newParent.position.set(-4, 1, 2)
  const child = new THREE.Group()
  root.add(oldParent, newParent)
  oldParent.add(child)
  return { root, newParent, child }
}

/** Pose the child as the editor's groups are posed: authored, or authored plus the mover's offset. */
const pose = (child: THREE.Group, previewing: boolean): void => {
  child.position.set(
    AUTHORED.x + (previewing ? MOTION.x : 0),
    AUTHORED.y + (previewing ? MOTION.y : 0),
    AUTHORED.z + (previewing ? MOTION.z : 0),
  )
}

describe('the pose a reparent re-expresses', () => {
  it('keeps the authored world position when read from the authored pose', () => {
    const { root, newParent, child } = scene()
    pose(child, false)
    root.updateWorldMatrix(true, true)
    const worldBefore = child.getWorldPosition(new THREE.Vector3())

    const local = localInside(child, newParent)
    // Apply it, as `reparent` does, and the object has not moved in the world.
    newParent.add(child)
    child.position.copy(local)
    root.updateWorldMatrix(true, true)
    const worldAfter = child.getWorldPosition(new THREE.Vector3())
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 9)
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 9)
    expect(worldAfter.z).toBeCloseTo(worldBefore.z, 9)
  })

  /** What the bug was: the mover's whole offset, baked into the stored local transform. */
  it('bakes the motion offset in when read from the previewed pose', () => {
    const { root, newParent, child } = scene()
    pose(child, true)
    root.updateWorldMatrix(true, true)
    const previewed = localInside(child, newParent)

    pose(child, false)
    root.updateWorldMatrix(true, true)
    const authored = localInside(child, newParent)

    expect(previewed.y - authored.y, 'exactly the offset the mover contributed').toBeCloseTo(MOTION.y, 9)
  })

  /** A still node has nothing to bake, which is why this went unnoticed on most of a level. */
  it('agrees for a node with no motion', () => {
    const { root, newParent, child } = scene()
    pose(child, false)
    root.updateWorldMatrix(true, true)
    const a = localInside(child, newParent)
    pose(child, false)
    root.updateWorldMatrix(true, true)
    const b = localInside(child, newParent)
    expect(a.y).toBeCloseTo(b.y, 9)
  })

  it('bakes it for a reparent to the level root too', () => {
    const { root, child } = scene()
    pose(child, true)
    root.updateWorldMatrix(true, true)
    const previewed = localInside(child, null)
    pose(child, false)
    root.updateWorldMatrix(true, true)
    const authored = localInside(child, null)
    expect(previewed.y - authored.y).toBeCloseTo(MOTION.y, 9)
  })
})
