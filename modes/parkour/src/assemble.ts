import { PART_NAMES, type PartName, type PartTransform } from '@mp/character'
import { clamp } from '@mp/core'
import { createLooseParts, THREE, type CharacterRigOptions } from '@mp/render-three'

/**
 * Spawn assembly: the body arrives a pair at a time, each part dropping from above into the place the
 * animated rig would have put it. Plays on the first spawn and on every respawn.
 *
 * Drawn with **loose parts** rather than through the rig, for the same reason the ragdoll is: the rig is a
 * hierarchy, so dropping the torso in would drag the legs that already landed down with it. Ten independent
 * meshes each go to their own place.
 *
 * The targets are recomputed every frame from the live pose, so nothing has to be frozen or input locked —
 * a player who is already walking simply has their parts fall in around them.
 */
export interface AssemblyTiming {
  /** Seconds between one pair starting and the next. */
  stagger: number
  /** Seconds a part takes to fall into place. */
  fall: number
  /** How far above its place a part starts (m). */
  height: number
}

export interface Assembly {
  /**
   * Draw the parts `elapsed` seconds in, falling toward `transforms`. Returns true once every part has
   * landed and the real rig should take over.
   */
  draw: (transforms: Record<PartName, PartTransform>, elapsed: number, timing: AssemblyTiming) => boolean
  dispose: () => void
}

/**
 * Which parts arrive together, and in what order: feet, then thighs, then the torso, then shoulders, then
 * forearms, then the head. Kodjo's order — it builds from the ground up.
 */
const ORDER: readonly (readonly PartName[])[] = [
  ['lowerLegL', 'lowerLegR'],
  ['upperLegL', 'upperLegR'],
  ['body'],
  ['upperArmL', 'upperArmR'],
  ['lowerArmL', 'lowerArmR'],
  ['head'],
]

/** Which step of the order each part belongs to. */
const STEP = Object.fromEntries(ORDER.flatMap((group, i) => group.map((name) => [name, i]))) as Record<PartName, number>

export const createAssembly = (opts: { scene: THREE.Scene; look?: CharacterRigOptions }): Assembly => {
  const parts = createLooseParts(opts.look)
  opts.scene.add(parts.group)

  return {
    draw: (transforms, elapsed, timing) => {
      let done = true
      for (const name of PART_NAMES) {
        const start = STEP[name] * timing.stagger
        const p = timing.fall > 0 ? clamp((elapsed - start) / timing.fall, 0, 1) : elapsed >= start ? 1 : 0
        const m = parts.mesh[name]
        // Not yet its turn: hidden entirely rather than parked in the air.
        m.visible = elapsed >= start
        if (p < 1) done = false
        const t = transforms[name]
        // `1 - p²` accelerates downward, so it reads as falling rather than easing in.
        m.position.set(t.position.x, t.position.y + timing.height * (1 - p * p), t.position.z)
        m.quaternion.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w)
      }
      return done
    },
    dispose: parts.dispose,
  }
}
