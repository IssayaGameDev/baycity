import { vec3, type Vec3 } from '@mp/core'

import type { Marker, Piece, Prefab } from './types'

/**
 * Greybox kit — parametric constructors that emit `Prefab` data (pieces + markers +
 * optional behavior). Author levels in TypeScript ergonomically, or place the results in
 * JSON. Geometry only: the collider is authored (crisp for the KCC) and the visual is a
 * greybox primitive keyed by `style`. Swapping in glTF art later never touches these.
 *
 * The set (which obstacle types) and their palette are Kodjo's design calls; this is a
 * neutral starter kit. `KIT_STYLE` keys are placeholders the renderer maps to colours (C3).
 */
export const KIT_STYLE = {
  ground: 'ground',
  platform: 'platform',
  ramp: 'ramp',
  moving: 'moving',
  hazard: 'hazard',
  checkpoint: 'checkpoint',
  goal: 'goal',
  spawn: 'spawn',
} as const

/** A greybox box piece: authored box collider + a matching primitive visual. */
const box = (halfExtents: Vec3, position: Vec3, style: string, rotation?: Vec3): Piece => ({
  collider: { kind: 'box', halfExtents },
  transform: rotation !== undefined ? { position, rotation } : { position },
  visual: { kind: 'primitive', style },
})

// ---- platforms --------------------------------------------------------------

export interface PlatformOpts {
  id?: string
  width?: number // x extent (m)
  depth?: number // z extent (m)
  thickness?: number // y extent (m)
  style?: string
}

/** A flat rectangular slab — the workhorse footing. */
export const platform = (o: PlatformOpts = {}): Prefab => {
  const width = o.width ?? 4
  const depth = o.depth ?? 4
  const thickness = o.thickness ?? 0.5
  return {
    id: o.id ?? 'platform',
    pieces: [box(vec3(width / 2, thickness / 2, depth / 2), vec3(0, 0, 0), o.style ?? KIT_STYLE.platform)],
  }
}

/** A thin, narrow foothold — a `platform` preset (no distinct mechanic; smaller defaults). */
export const ledge = (o: PlatformOpts = {}): Prefab =>
  platform({ id: o.id ?? 'ledge', width: o.width ?? 2, depth: o.depth ?? 1, thickness: o.thickness ?? 0.3, ...(o.style !== undefined ? { style: o.style } : {}) })

export interface RampOpts {
  id?: string
  width?: number // z extent (m)
  run?: number // horizontal distance covered (m)
  rise?: number // height gained (m)
  thickness?: number
  style?: string
}

/** An inclined slab rising `rise` over horizontal `run`. A tilted box (walkable if the
 * slope ≤ the controller's max climb angle). */
export const ramp = (o: RampOpts = {}): Prefab => {
  const width = o.width ?? 4
  const run = o.run ?? 4
  const rise = o.rise ?? 2
  const thickness = o.thickness ?? 0.5
  const length = Math.hypot(run, rise) // slab spans `run` horizontally once tilted
  const angle = Math.atan2(rise, run)
  return {
    id: o.id ?? 'ramp',
    pieces: [box(vec3(length / 2, thickness / 2, width / 2), vec3(0, 0, 0), o.style ?? KIT_STYLE.ramp, vec3(0, 0, angle))],
  }
}

export interface GapJumpOpts {
  id?: string
  width?: number // x extent of each platform (m)
  depth?: number // z extent (m)
  thickness?: number
  gap?: number // empty distance between the platform edges (m)
  style?: string
}

/** Two platforms separated by a gap along +x — a single placeable jump challenge. */
export const gapJump = (o: GapJumpOpts = {}): Prefab => {
  const width = o.width ?? 3
  const depth = o.depth ?? 3
  const thickness = o.thickness ?? 0.5
  const gap = o.gap ?? 3
  const half = vec3(width / 2, thickness / 2, depth / 2)
  const c = (width + gap) / 2
  const style = o.style ?? KIT_STYLE.platform
  return { id: o.id ?? 'gap-jump', pieces: [box(half, vec3(-c, 0, 0), style), box(half, vec3(c, 0, 0), style)] }
}

// ---- moving / rotating ------------------------------------------------------

export interface MovingPlatformOpts {
  id?: string
  width?: number
  depth?: number
  thickness?: number
  axis?: Vec3 // travel direction (normalized internally)
  amplitude?: number // peak offset from centre (m)
  periodMs?: number
  style?: string
}

/** A platform that oscillates along `axis` — carries the `move` behavior. */
export const movingPlatform = (o: MovingPlatformOpts = {}): Prefab => {
  const width = o.width ?? 3
  const depth = o.depth ?? 3
  const thickness = o.thickness ?? 0.4
  return {
    id: o.id ?? 'moving-platform',
    pieces: [box(vec3(width / 2, thickness / 2, depth / 2), vec3(0, 0, 0), o.style ?? KIT_STYLE.moving)],
    behavior: { kind: 'move', axis: o.axis ?? vec3(0, 1, 0), amplitude: o.amplitude ?? 1.5, periodMs: o.periodMs ?? 4000 },
  }
}

export interface RotatingBarOpts {
  id?: string
  length?: number // x extent of the bar (m)
  thickness?: number // y & z extent (m)
  axis?: Vec3 // spin axis (world), default +y (sweeps horizontally)
  periodMs?: number
  style?: string
}

/** A long thin bar spinning about `axis` — a sweeping obstacle. Carries `rotate`. */
export const rotatingBar = (o: RotatingBarOpts = {}): Prefab => {
  const length = o.length ?? 6
  const thickness = o.thickness ?? 0.3
  return {
    id: o.id ?? 'rotating-bar',
    pieces: [box(vec3(length / 2, thickness / 2, thickness / 2), vec3(0, 0, 0), o.style ?? KIT_STYLE.moving)],
    behavior: { kind: 'rotate', axis: o.axis ?? vec3(0, 1, 0), periodMs: o.periodMs ?? 3000 },
  }
}

// ---- marker pads ------------------------------------------------------------

export interface PadOpts {
  id?: string
  width?: number
  depth?: number
  thickness?: number
  radius?: number // marker trigger radius (m); ignored by spawn
  style?: string
}

type PadKind = 'spawn' | 'checkpoint' | 'goal' | 'hazard'

// Per-kind so each marker carries its literal `kind` (assignable to the Marker union).
const markerFor = (kind: PadKind, position: Vec3, radius: number): Marker => {
  switch (kind) {
    case 'spawn':
      return { kind: 'spawn', transform: { position } }
    case 'checkpoint':
      return { kind: 'checkpoint', transform: { position }, radius }
    case 'goal':
      return { kind: 'goal', transform: { position }, radius }
    case 'hazard':
      return { kind: 'hazard', transform: { position }, radius }
  }
}

// A footing slab + a marker on its top surface. The mode offsets a character onto the
// marker by its own height (content is height-agnostic).
const pad = (o: PadOpts, kind: PadKind, defaultId: string, style: string): Prefab => {
  const width = o.width ?? 3
  const depth = o.depth ?? 3
  const thickness = o.thickness ?? (kind === 'hazard' ? 0.2 : 0.5)
  return {
    id: o.id ?? defaultId,
    pieces: [box(vec3(width / 2, thickness / 2, depth / 2), vec3(0, 0, 0), o.style ?? style)],
    markers: [markerFor(kind, vec3(0, thickness / 2, 0), o.radius ?? 1.5)],
  }
}

/** A footing with a spawn marker. */
export const spawnPad = (o: PadOpts = {}): Prefab => pad(o, 'spawn', 'spawn-pad', KIT_STYLE.spawn)
/** A footing with a checkpoint marker (radius trigger). */
export const checkpointPad = (o: PadOpts = {}): Prefab => pad(o, 'checkpoint', 'checkpoint-pad', KIT_STYLE.checkpoint)
/** A footing with a goal marker (radius trigger). */
export const goalPad = (o: PadOpts = {}): Prefab => pad(o, 'goal', 'goal-pad', KIT_STYLE.goal)
/** A thin slab with a hazard marker (touch → the mode respawns you). */
export const hazardPad = (o: PadOpts = {}): Prefab => pad(o, 'hazard', 'hazard-pad', KIT_STYLE.hazard)
