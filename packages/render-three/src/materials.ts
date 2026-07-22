import type { ColliderDesc } from '@mp/content'
import * as THREE from 'three'

/**
 * The greybox visual language (content pipeline C3). One colour per `style` key —
 * the "High-contrast dev" palette (Kodjo's pick): flat, saturated, every obstacle type
 * instantly distinct. This is the single source of truth shared by the game and the
 * viewer. Swapping greybox → glTF art later replaces meshes, not this map.
 */
export const STYLE_PALETTE: Record<string, number> = {
  ground: 0x2b2b2b,
  platform: 0x9aa0a6,
  ramp: 0xc0c0c0,
  moving: 0x00bcd4,
  hazard: 0xff1744,
  checkpoint: 0x00e676,
  goal: 0xffea00,
  spawn: 0x2979ff,
}

const DEFAULT_COLOR = 0x475569
// Accent styles read as "active" — a touch of emissive so they hold their colour under
// ambient occlusion and catch bloom if it's enabled.
const ACCENT = new Set(['moving', 'hazard', 'checkpoint', 'goal', 'spawn'])

export const colorForStyle = (style: string | undefined): number =>
  style !== undefined && style in STYLE_PALETTE ? STYLE_PALETTE[style]! : DEFAULT_COLOR

/** A greybox surface material for a style. PBR standard material; matte, with a small
 * emissive lift on accent styles. */
export const createStyleMaterial = (style: string | undefined): THREE.MeshStandardMaterial => {
  const color = colorForStyle(style)
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.0 })
  if (style !== undefined && ACCENT.has(style)) {
    mat.emissive = new THREE.Color(color)
    mat.emissiveIntensity = 0.14
  }
  return mat
}

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
  }
}
