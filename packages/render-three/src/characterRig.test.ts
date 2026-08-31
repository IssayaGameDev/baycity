import { createAnimator, FOOT_Y, LIMB_LENGTH, PART_NAMES, RIG, restPose } from '@mp/humanoid'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { createCharacterRig } from './characterRig'

/** World position of a leg's sole: one segment below the lower-leg joint, in that joint's frame. */
const solePosition = (rig: ReturnType<typeof createCharacterRig>, side: 'L' | 'R'): THREE.Vector3 => {
  rig.root.updateMatrixWorld(true)
  const knee = rig.root.getObjectByName(`lowerLeg${side}`)
  expect(knee, 'lower leg node is named so tests can find it').toBeDefined()
  return knee!.localToWorld(new THREE.Vector3(0, -LIMB_LENGTH, 0))
}

describe('createCharacterRig', () => {
  it('builds one node per rig part, nested by the rig parent chain', () => {
    const rig = createCharacterRig()
    for (const name of PART_NAMES) {
      const node = rig.root.getObjectByName(name)
      expect(node, `missing node for ${name}`).toBeDefined()
      const parent = RIG[name].parent
      // The joint's parent node is the parent part's joint (or the root for the body).
      const expected = parent === null ? rig.root : rig.root.getObjectByName(parent)
      expect(node!.parent).toBe(expected)
    }
    rig.dispose()
  })

  it('stands with its soles on the capsule bottom in the rest pose', () => {
    // The realization has to agree with the rig data, or the visual sinks into or floats above what
    // collides. FOOT_Y is derived from the capsule, so this pins renderer against solver.
    const rig = createCharacterRig()
    rig.apply(restPose())
    for (const side of ['L', 'R'] as const) {
      expect(solePosition(rig, side).y).toBeCloseTo(FOOT_Y, 5)
    }
    rig.dispose()
  })

  it('keeps the soles at ground level while walking', () => {
    const rig = createCharacterRig()
    const animator = createAnimator()
    let lowest = Infinity
    for (let t = 0; t < 240; t++) {
      rig.apply(animator.step({ yaw: 0, speed: 4, grounded: true, rising: false }, 1 / 60))
      for (const side of ['L', 'R'] as const) lowest = Math.min(lowest, solePosition(rig, side).y)
    }
    // Never punches through the floor the capsule rests on.
    expect(lowest).toBeGreaterThan(FOOT_Y - 0.03)
    rig.dispose()
  })

  it('yaws the whole character, not individual parts', () => {
    const rig = createCharacterRig()
    const pose = restPose()
    pose.yaw = Math.PI / 2
    rig.apply(pose)
    rig.root.updateMatrixWorld(true)
    // A quarter turn about +y sends the body's local +z to world +x.
    const forward = rig.root.localToWorld(new THREE.Vector3(0, 0, 1))
    expect(forward.x).toBeCloseTo(1, 5)
    expect(forward.z).toBeCloseTo(0, 5)
    rig.dispose()
  })

  it('disposes its geometry and materials', () => {
    const rig = createCharacterRig()
    const geos: THREE.BufferGeometry[] = []
    rig.root.traverse((o) => {
      if (o instanceof THREE.Mesh) geos.push(o.geometry)
    })
    expect(geos.length).toBe(PART_NAMES.length)
    let disposed = 0
    for (const g of geos) g.addEventListener('dispose', () => (disposed += 1))
    rig.dispose()
    expect(disposed).toBe(geos.length)
  })
})
