import type { EntityId, Vec3 } from '@mp/core'
import { THREE } from '@mp/render-three'
import type { TpsClient } from '@mp/tps'

import { createPeerRopes } from './peerRopes'
import type { RopeTuning } from './rope'
import type { SwingState } from './swing'

/**
 * Every rope on screen — yours and everybody else's (ADR 0067, ADR 0068).
 *
 * **Per rendered frame, not per tick**, which is why ADR 0066 exists: the hand a rope hangs from is animated
 * per frame, so a rope redrawn at 30 Hz would visibly detach from it at any refresh rate above the tick rate.
 *
 * Yours comes straight from the component's own state. A peer's is worked out locally, because the anchor is a
 * position and the wire carries no positions — see `peerRopes.ts` for how, and for where it is approximate.
 *
 * Two segments and no sag. A catenary would be prettier and is a look decision nobody has made; a straight line
 * is what a stiff rope under load looks like, which is the case that matters.
 */
export const drawRopes = (client: TpsClient, state: SwingState, tuning: () => RopeTuning): (() => void) => {
  const peerRopes = createPeerRopes()
  /** One line per body that has ever needed one, kept and hidden rather than rebuilt every grab. */
  const lines = new Map<EntityId, THREE.Line>()

  const lineFor = (id: EntityId, colour: number): THREE.Line => {
    const existing = lines.get(id)
    if (existing !== undefined) return existing
    const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()])
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: colour }))
    // Both ends move every frame; a stale bounding box blinks the line out at glancing angles.
    line.frustumCulled = false
    line.visible = false
    client.scene.add(line)
    lines.set(id, line)
    return line
  }

  /** Hand to anchor, if there is a rig drawn to hang it from. */
  const stretch = (id: EntityId, anchor: Vec3, colour: number): void => {
    const line = lineFor(id, colour)
    const parts = client.partsOf(id)
    if (parts === null) {
      line.visible = false
      return
    }
    // The hand as it was *drawn*, not where the capsule is: `partsOf` is world-space for exactly this.
    const hand = parts.lowerArmR.position
    const positions = line.geometry.attributes['position'] as THREE.BufferAttribute
    positions.setXYZ(0, hand.x, hand.y, hand.z)
    positions.setXYZ(1, anchor.x, anchor.y, anchor.z)
    positions.needsUpdate = true
    line.visible = true
  }

  const off = client.onFrame(() => {
    const drawn = new Set<EntityId>()

    const me = client.id()
    if (me !== null && state.rope !== null) {
      stretch(me, state.rope.anchor, SELF_ROPE)
      drawn.add(me)
    }

    const peers = client.peers()
    peerRopes.update(peers, client.world(), tuning())
    for (const id of peerRopes.holders()) {
      const rope = peerRopes.ropeOf(id)
      if (rope === undefined) continue
      stretch(id, rope.anchor, PEER_ROPE)
      drawn.add(id)
    }

    // Everything not drawn this frame: let go, died, or left.
    for (const [id, line] of lines) if (!drawn.has(id)) line.visible = false
  })

  return () => {
    off()
    for (const line of lines.values()) {
      client.scene.remove(line)
      line.geometry.dispose()
      ;(line.material as THREE.Material).dispose()
    }
    lines.clear()
  }
}

/** Yours reads warm; theirs cooler, so a crowded screen still says which rope is yours. */
const SELF_ROPE = 0xf5deb3
const PEER_ROPE = 0x93a3b8
