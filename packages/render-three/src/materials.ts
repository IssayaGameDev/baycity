import type { ColliderDesc, WorldMarker } from '@mp/content'
import * as THREE from 'three'
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js'

/**
 * Marker colours and the no-material surface. Both are renderer chrome, not content.
 *
 * This file used to hold `STYLE_PALETTE`: eight colour keys that content referenced by name, which made the
 * renderer a second authoring system alongside material assets. That is gone (ADR 0028) — the seven keys
 * content actually used now ship as material assets under `content/assets/materials/`.
 *
 * What legitimately stayed is the part that was never content: the colours of the **marker gizmos**
 * (spawn/checkpoint/goal/hazard pads and their editor wireframes) are debug chrome nobody authors, and the
 * grey a primitive draws in when no material has been chosen.
 */
export const MARKER_COLORS: Record<WorldMarker['kind'], number> = {
  spawn: 0x2979ff,
  checkpoint: 0x00e676,
  goal: 0xffea00,
  hazard: 0xff1744,
}

export const colorForMarker = (kind: WorldMarker['kind']): number => MARKER_COLORS[kind]

/** The unauthored surface: flat matte grey, which is what "no material chosen" looks like. */
const GREYBOX_COLOR = 0x475569

/**
 * A surface for a primitive with no material asset. Deliberately plain and deliberately not
 * configurable — it is the absence of a choice, so making it tunable would recreate the palette this
 * replaced. Choose a material to change how something looks.
 */
export const createGreyboxMaterial = (): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color: GREYBOX_COLOR, roughness: 0.85, metalness: 0.0 })

/** Build the render geometry matching a collider primitive (greybox: visual == collider). */
export const geometryForCollider = (c: ColliderDesc): THREE.BufferGeometry => {
  switch (c.kind) {
    case 'box':
      return new THREE.BoxGeometry(c.halfExtents.x * 2, c.halfExtents.y * 2, c.halfExtents.z * 2)
    case 'capsule':
      return new THREE.CapsuleGeometry(c.radius, c.halfHeight * 2, 8, 20)
    case 'ball':
      return new THREE.SphereGeometry(c.radius, 28, 18)
    case 'cylinder':
      return new THREE.CylinderGeometry(c.radius, c.radius, c.halfHeight * 2, 28)
    case 'convex':
      // Same points Rapier hulls for collision, so the mesh and the collider are one description
      // rather than two that have to be kept in agreement (ADR 0017).
      return new ConvexGeometry(c.points.map((p) => new THREE.Vector3(p.x, p.y, p.z)))
  }
}
