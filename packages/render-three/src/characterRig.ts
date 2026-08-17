import { PART_NAMES, RIG, type PartName, type Pose } from '@mp/character'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'

/**
 * Realizes `@mp/character`'s rig data as Three.js nodes and applies a `Pose`. The same split the
 * level pipeline uses: the headless package decides shape and motion, this one only draws it.
 *
 * One node per part, nested by the rig's parent chain, with the box offset *below* its joint so
 * writing a joint's rotation swings the limb instead of spinning it about its middle. Posing is
 * therefore ten quaternion writes and one vector — no skinning, no morphs, no clips.
 */
export interface CharacterRigOptions {
  /** Corner radius (m). 0 gives hard edges; ~0.03 reads as a soft blocky toy. */
  cornerRadius?: number
  /** Per-style colours, so self and peers can be tinted apart. */
  colors?: Partial<Record<RigStyle, number>>
  castShadow?: boolean
}

export type RigStyle = 'skin' | 'shirt' | 'trousers'

/** Shared, read-only: every joint but the body adds no bob/crouch travel of its own. */
const ZERO = { x: 0, y: 0, z: 0 }

const DEFAULT_COLORS: Record<RigStyle, number> = {
  skin: 0xf2c49b,
  shirt: 0x3b82f6,
  trousers: 0x1f2937,
}

export interface CharacterRig {
  /** Add this to the scene and place it at the character's root (capsule centre). */
  root: THREE.Group
  /** Write a pose onto the nodes. Cheap — call every rendered frame. */
  apply: (pose: Pose) => void
  dispose: () => void
}

export const createCharacterRig = (opts: CharacterRigOptions = {}): CharacterRig => {
  const radius = opts.cornerRadius ?? 0.03
  const colors = { ...DEFAULT_COLORS, ...opts.colors }
  const castShadow = opts.castShadow ?? true

  const root = new THREE.Group()
  const joints = {} as Record<PartName, THREE.Group>
  const owned: (THREE.BufferGeometry | THREE.Material)[] = []

  const materials = new Map<RigStyle, THREE.MeshStandardMaterial>()
  const materialFor = (style: RigStyle): THREE.MeshStandardMaterial => {
    let m = materials.get(style)
    if (m === undefined) {
      m = new THREE.MeshStandardMaterial({ color: colors[style], roughness: 0.7 })
      materials.set(style, m)
      owned.push(m)
    }
    return m
  }

  // Parents before children: the rig lists the body first and every part's parent precedes it.
  for (const name of PART_NAMES) {
    const part = RIG[name]
    const joint = new THREE.Group()
    joint.name = name // so callers (and tests) can find a specific joint
    joint.position.set(part.pivot.x, part.pivot.y, part.pivot.z)

    const geo =
      radius > 0
        ? new RoundedBoxGeometry(part.size.x, part.size.y, part.size.z, 2, Math.min(radius, Math.min(part.size.x, part.size.y, part.size.z) / 2 - 1e-3))
        : new THREE.BoxGeometry(part.size.x, part.size.y, part.size.z)
    owned.push(geo)

    const mesh = new THREE.Mesh(geo, materialFor(part.style))
    mesh.position.set(part.meshOffset.x, part.meshOffset.y, part.meshOffset.z)
    mesh.castShadow = castShadow
    mesh.receiveShadow = castShadow
    joint.add(mesh)

    joints[name] = joint
    const parent = part.parent
    if (parent === null) root.add(joint)
    else joints[parent].add(joint)
  }

  return {
    root,
    apply: (pose) => {
      root.rotation.y = pose.yaw
      // Joints both rotate and translate: `jointOffset` carries the spring layer's secondary motion,
      // and the body adds its own bob/crouch travel on top (that one is in the leg IK, the rest are
      // not). Most entries are permanently zero, so this stays ten writes of each kind.
      for (const name of PART_NAMES) {
        const rest = RIG[name].pivot
        const o = pose.jointOffset[name]
        const b = name === 'body' ? pose.bodyOffset : ZERO
        joints[name].position.set(rest.x + o.x + b.x, rest.y + o.y + b.y, rest.z + o.z + b.z)
        const r = pose.rotation[name]
        joints[name].quaternion.set(r.x, r.y, r.z, r.w)
      }
    },
    dispose: () => {
      root.removeFromParent()
      for (const o of owned) o.dispose()
    },
  }
}
