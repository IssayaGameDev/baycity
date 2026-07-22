import { CHAR_HALF_HEIGHT, CHAR_RADIUS } from '@mp/character'
import type { EntityId, Vec3 } from '@mp/core'
import { THREE } from '@mp/render-three'

import { makeNameLabel } from './nametag'

/**
 * Renders the players (own + peers) as capsule + facing-nose groups with billboard nametags,
 * and eases facing toward a target yaw (or the movement direction). Owns the per-player view
 * state; the mode just pushes positions/names each frame.
 */
interface Rendered {
  group: THREE.Group
  facing: number
  last: Vec3
  label?: THREE.Sprite
  labelText?: string
}

export interface CharacterPlacement {
  isSelf: boolean
  position: Vec3
  yaw: number | null // desired facing; null → face the movement direction
  name: string
}

export interface CharacterViews {
  /** Create or update a player's view for this frame. */
  upsert: (id: EntityId, placement: CharacterPlacement) => void
  /** Remove any players whose id isn't in `keep` (left the room). */
  prune: (keep: Set<EntityId>) => void
}

const facingFromDelta = (r: Rendered, p: Vec3): number | null => {
  const dx = p.x - r.last.x
  const dz = p.z - r.last.z
  return dx * dx + dz * dz > 1e-5 ? Math.atan2(dx, dz) : null
}
// Shortest-arc ease of an angle toward a target.
const easeAngle = (from: number, to: number, t: number): number => {
  let d = ((to - from + Math.PI) % (Math.PI * 2)) - Math.PI
  if (d < -Math.PI) d += Math.PI * 2
  return from + d * t
}

export const createCharacterViews = (scene: THREE.Scene): CharacterViews => {
  const charGeo = new THREE.CapsuleGeometry(CHAR_RADIUS, CHAR_HALF_HEIGHT * 2, 6, 16)
  const chars = new Map<EntityId, Rendered>()

  // A capsule body + a "nose" so facing is visible.
  const makeCharacter = (color: number): THREE.Group => {
    const g = new THREE.Group()
    const body = new THREE.Mesh(charGeo, new THREE.MeshStandardMaterial({ color, roughness: 0.6 }))
    body.castShadow = true
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 0.4), new THREE.MeshStandardMaterial({ color: 0x0b1020 }))
    nose.position.set(0, 0.2, CHAR_RADIUS) // +z front
    nose.castShadow = true
    g.add(body, nose)
    scene.add(g)
    return g
  }

  const charFor = (id: EntityId, isSelf: boolean): Rendered => {
    let r = chars.get(id)
    if (r === undefined) {
      r = { group: makeCharacter(isSelf ? 0xfacc15 : 0xf97316), facing: 0, last: { x: 0, y: 0, z: 0 } }
      chars.set(id, r)
    }
    return r
  }

  const setLabel = (r: Rendered, name: string): void => {
    if (r.labelText === name) return
    if (r.label !== undefined) {
      r.group.remove(r.label)
      r.label.material.map?.dispose()
      r.label.material.dispose()
    }
    r.label = makeNameLabel(name)
    r.labelText = name
    r.group.add(r.label)
  }

  return {
    upsert: (id, { isSelf, position, yaw, name }) => {
      const r = charFor(id, isSelf)
      r.group.position.set(position.x, position.y, position.z)
      const target = yaw ?? facingFromDelta(r, position)
      if (target !== null) r.facing = easeAngle(r.facing, target, 0.25)
      r.group.rotation.y = r.facing
      r.last = { x: position.x, y: position.y, z: position.z }
      setLabel(r, name)
    },
    prune: (keep) => {
      for (const [id, r] of chars)
        if (!keep.has(id)) {
          scene.remove(r.group)
          chars.delete(id)
        }
    },
  }
}
