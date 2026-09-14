import { builtinShape, type BuiltinModel, type ColliderDesc } from '@mp/content'
import type { Vec3 } from '@mp/core'
import * as THREE from 'three'
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'

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
/**
 * What the editor and the viewer draw a coloured wireframe for: the spawn point, and each gameplay rule.
 *
 * Declared here rather than derived from a content type, because that is all it is — a palette key for debug
 * chrome. It used to be `WorldMarker['kind'] | TriggerKind`, which tied a renderer's colour table to the
 * authoring schema and outlived both of those types (ADR 0035). A mode's `RULE_KINDS` maps its rule components
 * onto these names.
 */
export type GizmoKind = 'spawn' | 'checkpoint' | 'goal' | 'hazard' | 'bumper'

export const MARKER_COLORS: Record<GizmoKind, number> = {
  spawn: 0x2979ff,
  checkpoint: 0x00e676,
  goal: 0xffea00,
  hazard: 0xff1744,
  bumper: 0xff9100,
}

export const colorForMarker = (kind: GizmoKind): number => MARKER_COLORS[kind]

/** The unauthored surface: flat matte grey, which is what "no material chosen" looks like. */
const GREYBOX_COLOR = 0x475569

/**
 * A surface for a primitive with no material asset. Deliberately plain and deliberately not
 * configurable — it is the absence of a choice, so making it tunable would recreate the palette this
 * replaced. Choose a material to change how something looks.
 */
export const createGreyboxMaterial = (): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color: GREYBOX_COLOR, roughness: 0.85, metalness: 0.0 })

/**
 * The standard bevel, in metres. Every code-generated box in the game is a rounded cuboid at this radius, so
 * the world is made of the same stuff the character is (ADR 0044).
 *
 * **Constant world units**, not a fraction of the object. A fraction would round a 40 m floor and a 0.3 m step
 * by wildly different amounts and read as two different materials. The price is that the bevel is
 * proportionally invisible on very large solids, which is the correct trade: the eye reads a constant
 * highlight width as one material.
 */
export const BEVEL_RADIUS = 0.5

/**
 * Rounding steps per corner. Three doubles this and adds one, so 2 subdivides each face 5x5 and yields a
 * non-indexed 900-vertex box. At this radius anything above 1 is already smooth; 2 is what the character rig
 * has always used, and matching it is the point.
 */
export const BEVEL_SEGMENTS = 2

/**
 * The most of the shortest side a bevel may eat.
 *
 * Three clamps a rounded box's radius at *half* the shortest side, and half is exactly the point where the
 * flat face vanishes and a thin plate becomes a pill. A quarter leaves half of every face flat, so a 0.06 m
 * plate still reads as a plate rather than a tube. This is what keeps `BEVEL_RADIUS` safe to raise.
 */
const MAX_BEVEL_FRACTION = 0.25

/**
 * The bevel a box of this size actually gets: the standard radius, backed off on anything too thin to carry
 * it. `wanted` exists for the character rig, whose caller may override the radius per rig.
 *
 * Never changes a box's silhouette — a rounded cuboid has the same bounding box as the sharp one, so the drawn
 * mesh still fills its collider exactly.
 */
export const bevelFor = (sx: number, sy: number, sz: number, wanted: number = BEVEL_RADIUS): number =>
  Math.max(0, Math.min(wanted, Math.min(sx, sy, sz) * MAX_BEVEL_FRACTION))

const shapeGeometry = (c: ColliderDesc, bevel: boolean): THREE.BufferGeometry => {
  switch (c.kind) {
    case 'box': {
      const w = c.halfExtents.x * 2
      const h = c.halfExtents.y * 2
      const d = c.halfExtents.z * 2
      const r = bevel ? bevelFor(w, h, d) : 0
      return r > 0 ? new RoundedBoxGeometry(w, h, d, BEVEL_SEGMENTS, r) : new THREE.BoxGeometry(w, h, d)
    }
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

/** Build the render geometry matching a collider primitive (greybox: visual == collider, wearing the bevel). */
export const geometryForCollider = (c: ColliderDesc): THREE.BufferGeometry => shapeGeometry(c, true)

/**
 * A built-in shape (ADR 0090) at a node's world scale: the unit shape scaled, rounded only for the rounded
 * box — built from the final dimensions, so the bevel is right at any scale, which a scaled unit mesh could
 * not be.
 */
export const geometryForBuiltin = (id: BuiltinModel, scale: Vec3): THREE.BufferGeometry => {
  const { collider, rounded } = builtinShape(id, scale)
  return shapeGeometry(collider, rounded)
}

/**
 * The same shape with hard edges, for **overlays**.
 *
 * `EdgesGeometry` keeps every seam whose faces differ by more than a degree, and a rounded box's subdivisions
 * all qualify — so a wireframe built from the drawn mesh comes out as hatching instead of twelve lines. Only
 * boxes differ; every other kind returns the same geometry either way.
 */
export const outlineGeometryForCollider = (c: ColliderDesc): THREE.BufferGeometry => shapeGeometry(c, false)
