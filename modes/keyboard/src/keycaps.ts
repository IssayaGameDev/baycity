import { defineComponent } from '@mp/components'
import type { Vec3 } from '@mp/core'
import type { LoadedLevel, VisualItem } from '@mp/content'
import { THREE } from '@mp/render-three'
import type { TpsClient } from '@mp/tps'

import { DEFAULT_KEYCAP_SHAPE, keycapGeometry, type KeycapShape } from './keycapGeometry'

/**
 * A platform's top face, tiled with keycaps that press when you step on them (ADR 0069).
 *
 * The scale is the point and it is the opposite of what "giant keyboard" suggests: the player is 2 m tall and a
 * cap is 0.9 m, so a stride covers a couple of them. Caps are **surface detail that reacts**, not platforms —
 * which is what makes "+1 per step" land, because there is always a key under your foot.
 *
 * Two consequences follow from the count. A board is hundreds of caps, so:
 *
 * - **No per-cap colliders.** The collider is the platform box that was already authored. Which cap a footfall
 *   hit is arithmetic on the foot's position, not a physics contact — cheap, exact, and it works for other
 *   players without anything on the wire.
 * - **No per-cap nodes.** Hundreds of nodes per platform would be unauthorable and unloadable. The component is
 *   *data* on one node, and the caps are generated.
 */

/** The component a level author places. Data only: nothing here draws or collides. */
export const Keyboard = defineComponent({
  type: 'Keyboard',
  label: 'Keyboard surface',
  params: {
    /** Centre-to-centre spacing (m). Life-size is ~0.2. 0.9 is Kodjo's, after seeing 0.2 then 0.6 in play. */
    pitch: { kind: 'number', default: 0.9, min: 0.05, max: 3, step: 0.01, label: 'pitch m' },
    /** Cap footprint as a fraction of the pitch. The remainder is the gap you can see between keys. */
    fill: { kind: 'number', default: 0.88, min: 0.3, max: 1, step: 0.01, label: 'cap fill' },
    /** How far a cap stands above the platform's face (m). */
    height: { kind: 'number', default: 0.45, min: 0.005, max: 1.5, step: 0.005, label: 'cap height m' },
    /**
     * Which letters get used, and in what order — hashed per cell, so the same level always reads the same.
     *
     * Not a real QWERTY layout: Kodjo's call was individual caps with letters scattered over them, so the
     * layout is deliberately meaningless.
     */
    glyphs: { kind: 'string', default: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', label: 'glyphs' },
    /** Change it and every cap re-letters. Same seed, same board, on every machine. */
    seed: { kind: 'number', default: 1, min: 0, max: 9999, step: 1, label: 'letter seed' },
  },
  singleton: true,
})

export interface KeycapLook {
  /** Cap top and sides. */
  cap: number
  /** The letter printed on it. */
  ink: number
}

export const DEFAULT_KEYCAP_LOOK: KeycapLook = { cap: 0xe8e6e1, ink: 0x2b2b31 }

export interface PressFeel {
  /** How far a held cap travels, as a fraction of its height. */
  depth: number
  /** Seconds from resting to fully down. */
  downTime: number
  /** Seconds from fully down back to resting. Slower than `downTime` reads as a spring returning. */
  upTime: number
}

export const DEFAULT_PRESS: PressFeel = { depth: 0.85, downTime: 0.05, upTime: .65 }

export interface Keycaps {
  /**
   * Hold down every cap under this footprint.
   *
   * **Occupancy, not an event.** A cap is down for as long as somebody is standing over it and springs back
   * when they leave — so standing still leaves a print of your feet in the board rather than a key that bobs
   * once and pops up under you. Call it once per character per frame; anything not called for goes back up.
   *
   * `radius` is the character's footprint, so a 0.4 m capsule on a 0.6 m pitch holds one to four caps
   * depending on where it is standing, which is what makes the print read as feet.
   *
   * Silently does nothing when there is no board under the point, which is the common case — most of a level
   * is not a keyboard.
   *
   * **Returns the top of every cap this hold newly struck** — down from resting, not merely still held.
   *
   * The count is the "+1 per key" of ADR 0071 and the positions are where its popup comes from (ADR 0072), so
   * one call answers both rather than the caller looking the same caps up twice. Per-hold rather than global on
   * purpose: every character presses keys, and only the local player's presses earn Experience.
   *
   * The **top** of the cap, not its base: a label that spawned inside the board would be born clipped.
   */
  hold: (centre: Vec3, radius: number) => readonly Vec3[]
  /**
   * `hold` along a path: every cap under the footprint anywhere between `from` and `to`, not only at `to`.
   *
   * One `hold` per frame at the current position skips keys once a frame's travel exceeds the footprint — at
   * 32 m/s that is every frame under 40 fps, and every dropped frame at any rate. Sampled no wider apart than
   * `radius`, so two footprints always overlap. A `from` of `null` (first sight of a character) or a jump longer
   * than `MAX_SWEEP` (a respawn, a reconciliation) is treated as no path: pressing every key between spawn and
   * where you died is not what a teleport means.
   */
  sweep: (from: Vec3 | null, to: Vec3, radius: number) => readonly Vec3[]
  /**
   * Once per rendered frame, **after every `hold`**.
   *
   * Ordered that way on purpose and not on an internal frame hook: the hooks run in registration order, and a
   * hook made inside `drawKeycaps` would always settle the caps before the game had said who is standing
   * where — pressing everything one frame late.
   */
  update: (dt: number) => void
  /** Whether the boards exist yet. The level arrives with the first snapshot (ADR 0055). */
  ready: () => boolean
  dispose: () => void
}

/**
 * How far from a board's face a sole still counts as standing on it (m).
 *
 * Small on purpose. Every centimetre of it is a centimetre of air in which a falling player presses keys.
 */
export const DEFAULT_REACH = 0.35

/**
 * One board's frame and grid, kept so a world point can be turned back into a cell.
 *
 * `startX`/`startZ` are stored rather than recomputed because the lookup has to invert **exactly** the
 * arithmetic the placement used. Two copies of that rule is how a press lands one cap over.
 */
export interface Board {
  origin: THREE.Vector3
  quat: THREE.Quaternion
  /** The inverse, precomputed: every footfall needs it, twice a second per player. */
  inverse: THREE.Quaternion
  half: Vec3
  pitch: number
  startX: number
  startZ: number
  cols: number
  rows: number
}

/** One placed cap: where it rests, which instance draws it, and how far down it currently is. */
interface Cap {
  mesh: THREE.InstancedMesh
  index: number
  rest: THREE.Vector3
  quat: THREE.Quaternion
  scale: THREE.Vector3
  /** The board's own down, so a cap on a tilted board sinks into it rather than straight toward the floor. */
  down: THREE.Vector3
  /** Somebody is standing over it right now. Cleared every frame and re-asserted by `hold`. */
  held: boolean
  /**
   * Struck, and not yet all the way down. A cap that is stepped on goes **fully** down before it may rise,
   * however briefly the foot was there: a running player crosses a cap in a frame or two, and a key that only
   * dips a little for that does not read as pressed.
   */
  committed: boolean
  /** How far down it is, 0…1. Eased toward 1 while held or committed, else toward 0. */
  at: number
}

/**
 * Longest path a single frame may sweep (m). A frame at 15 fps and 32 m/s is 2.1 m; a respawn is tens of metres.
 * Anything past this is a teleport and presses nothing on the way.
 */
export const MAX_SWEEP = 4

/**
 * Points along `from → to`, no further apart than `spacing`, ending exactly at `to`. `from` itself is not
 * included: it was the previous frame's `to` and has already been pressed.
 */
export const sweepPoints = (from: Vec3, to: Vec3, spacing: number): Vec3[] => {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const length = Math.hypot(dx, dy, dz)
  const steps = Math.max(1, Math.ceil(length / Math.max(spacing, 1e-3)))
  const out: Vec3[] = []
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    out.push({ x: from.x + dx * t, y: from.y + dy * t, z: from.z + dz * t })
  }
  return out
}

/** The part of a cap's state the press animation reads and writes. */
export interface PressState {
  held: boolean
  committed: boolean
  at: number
}

/**
 * Advance one cap's press by `dt`. Returns whether the cap still needs animating.
 *
 * Down toward 1 while somebody stands on it **or** it was struck and has not reached the bottom yet; up toward 0
 * otherwise. `held` is consumed here rather than in `hold`, so a cap keeps its state until something asserts it
 * again. Pure, so it can be tested without a mesh.
 */
export const advancePress = (cap: PressState, feel: PressFeel, dt: number): boolean => {
  const downStep = dt / Math.max(1e-4, feel.downTime)
  const upStep = dt / Math.max(1e-4, feel.upTime)
  const target = cap.held || cap.committed ? 1 : 0
  cap.held = false
  if (cap.at !== target) cap.at = target > cap.at ? Math.min(target, cap.at + downStep) : Math.max(target, cap.at - upStep)
  if (cap.at >= 1) cap.committed = false
  // Fully back up and nobody standing on it: nothing left to animate.
  return !(cap.at === 0 && target === 0)
}

/**
 * Build every board in the level as one instanced mesh per glyph, and animate the presses (ADR 0069).
 *
 * **Per glyph, not per board**, and pooled across the whole level: 26 draw calls for every keyboard in the
 * level put together, rather than one per cap. The alternative — one mesh with a per-instance UV offset into a
 * glyph atlas — needs a shader patch to buy nothing at this scale.
 *
 * Returns the call that takes it all down again. Nothing tracks what a game adds to the scene (ADR 0066), so
 * this owns its own teardown.
 */
export const drawKeycaps = (
  client: TpsClient,
  look: KeycapLook = DEFAULT_KEYCAP_LOOK,
  shape: KeycapShape = DEFAULT_KEYCAP_SHAPE,
  feel: PressFeel = DEFAULT_PRESS,
): Keycaps => {
  const meshes: THREE.InstancedMesh[] = []
  const textures: THREE.Texture[] = []
  const boards: Board[] = []
  /** Every cap, by `board:col:row`. */
  const caps = new Map<string, Cap>()
  /**
   * Only the caps actually moving.
   *
   * A board is hundreds of caps and at most a handful are down at once, so the per-frame work is the size of
   * what is happening rather than the size of the level.
   */
  const active = new Set<Cap>()
  /**
   * One cap, shared by every instance of every letter on every board.
   *
   * Built here rather than per glyph: the shape does not vary, so 26 copies would be 26 uploads of the same
   * ~350 triangles.
   */
  const geometry = keycapGeometry(shape)

  const scratch = new THREE.Matrix4()
  const scratchVec = new THREE.Vector3()

  const build = (loaded: LoadedLevel): void => {
    /** Every cap, grouped by the letter on it, with the board and cell it came from. */
    const byGlyph = new Map<string, { key: string; matrix: THREE.Matrix4; down: THREE.Vector3 }[]>()

    for (const item of loaded.visuals) {
      const params = keyboardOn(loaded, item)
      if (params === null || item.collider.kind !== 'box') continue
      const board = boardOf(item, params)
      if (board === null) continue
      const boardIndex = boards.length
      boards.push(board)
      const down = new THREE.Vector3(0, -1, 0).applyQuaternion(board.quat)

      for (const cap of capsFor(board, item.collider.halfExtents, params)) {
        const list = byGlyph.get(cap.glyph) ?? []
        list.push({ key: `${boardIndex}:${cap.col}:${cap.row}`, matrix: cap.matrix, down })
        byGlyph.set(cap.glyph, list)
      }
    }

    for (const [glyph, placed] of byGlyph) {
      const texture = glyphTexture(glyph, look)
      textures.push(texture)
      const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.5, metalness: 0 })
      const mesh = new THREE.InstancedMesh(geometry, material, placed.length)
      // Dynamic, because pressing rewrites a cap's matrix. Static uploads once and would never show a press.
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      /**
       * **No shadow casting.** It was the single largest cost: a whole extra pass over every cap in the level,
       * through a 2048² PCF-soft map, for the self-shadowing of 0.3 m bumps on a flat board. The board still
       * casts, so the level's silhouette is unchanged.
       *
       * Receiving stays on, because that is the player's shadow falling across the keys — and it costs no
       * extra pass, only the fragment work the board underneath was paying anyway.
       */
      mesh.castShadow = false
      mesh.receiveShadow = true

      placed.forEach((p, i) => {
        mesh.setMatrixAt(i, p.matrix)
        const rest = new THREE.Vector3()
        const quat = new THREE.Quaternion()
        const scale = new THREE.Vector3()
        // Decomposed once and kept: a press re-composes from these rather than reading the matrix back out.
        p.matrix.decompose(rest, quat, scale)
        caps.set(p.key, { mesh, index: i, rest, quat, scale, down: p.down, held: false, committed: false, at: 0 })
      })
      mesh.instanceMatrix.needsUpdate = true
      /**
       * Frustum culling needs the instances' bounds, not the geometry's.
       *
       * Without this Three culls against the **unit cap's** sphere sitting at the mesh's origin, which for a
       * board 40 m down the level is both wrong and useless: boards behind the camera were never skipped. The
       * instances do not move — a press travels 0.25 m — so this is computed once.
       */
      mesh.computeBoundingSphere()
      client.scene.add(mesh)
      meshes.push(mesh)
    }
  }

  const self: Keycaps = {
    ready: () => boards.length > 0,

    hold: (centre, radius) => {
      const struck: Vec3[] = []
      for (const cap of capsUnder(boards, caps, centre, radius)) {
        // Newly struck: resting, and nobody else already claimed it this frame. `held` is cleared in `update`,
        // so a cap under two players at once is struck once and by whoever is asked first.
        if (cap.at === 0 && !cap.held) {
          cap.committed = true
          struck.push({
            x: cap.rest.x - cap.down.x * cap.scale.y,
            y: cap.rest.y - cap.down.y * cap.scale.y,
            z: cap.rest.z - cap.down.z * cap.scale.y,
          })
        }
        cap.held = true
        active.add(cap)
      }
      return struck
    },

    sweep: (from, to, radius) => {
      if (from === null) return self.hold(to, radius)
      const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
      if (length > MAX_SWEEP) return self.hold(to, radius)
      const struck: Vec3[] = []
      // A cap struck at one sample is `held` by the next, so the guard in `hold` counts it once.
      for (const point of sweepPoints(from, to, radius)) struck.push(...self.hold(point, radius))
      return struck
    },

    update: (dt) => {
      /**
       * Built on the frame the level first exists.
       *
       * The level arrives with the first snapshot rather than at startup (ADR 0055), so there is nothing to
       * read until then — and once read, none of it changes.
       */
      if (boards.length === 0) {
        const loaded = client.level()
        if (loaded !== null) build(loaded)
        return
      }

      if (active.size === 0) return
      const dirty = new Set<THREE.InstancedMesh>()

      for (const cap of [...active]) {
        // Down faster than up: a key that returns as quickly as it depresses reads as rubber. And a struck cap
        // goes all the way down before it may rise, however brief the step.
        if (!advancePress(cap, feel, dt)) active.delete(cap) // fully up and unheld: stop paying for it

        scratchVec.copy(cap.rest).addScaledVector(cap.down, cap.at * feel.depth * cap.scale.y)
        scratch.compose(scratchVec, cap.quat, cap.scale)
        cap.mesh.setMatrixAt(cap.index, scratch)
        dirty.add(cap.mesh)
      }
      for (const mesh of dirty) mesh.instanceMatrix.needsUpdate = true
    },

    dispose: () => {
      for (const mesh of meshes) {
        client.scene.remove(mesh)
          ; (mesh.material as THREE.Material).dispose()
        mesh.dispose()
      }
      // Shared by every mesh, so disposed once rather than per glyph.
      geometry.dispose()
      for (const texture of textures) texture.dispose()
      meshes.length = 0
      textures.length = 0
      boards.length = 0
      caps.clear()
      active.clear()
    },
  }
  return self
}

/**
 * Every cap a footprint of `radius` covers, on whichever board is under it.
 *
 * Generic in the cap so the arithmetic can be tested without building an instanced mesh — this is the part
 * that presses a key one cell over from the foot, and it needs no renderer to check.
 *
 * A **cell range** rather than a scan: the footprint's local bounds give the columns and rows it can possibly
 * touch, so the cost is the handful of cells around a character and not the hundreds on the board. Each
 * candidate is then checked against the real distance, so a corner cell just outside the circle is not pressed.
 */
export const capsUnder = <T>(
  boards: readonly Board[],
  caps: ReadonlyMap<string, T>,
  centre: Vec3,
  radius: number,
  reach = DEFAULT_REACH,
): T[] => {
  const local = new THREE.Vector3()
  const found: T[] = []
  for (let b = 0; b < boards.length; b += 1) {
    const board = boards[b]!
    local
      .set(centre.x - board.origin.x, centre.y - board.origin.y, centre.z - board.origin.z)
      .applyQuaternion(board.inverse)
    if (Math.abs(local.x) > board.half.x + radius || Math.abs(local.z) > board.half.z + radius) continue
    /**
     * A **thin** band around the face, and thin is the whole point.
     *
     * `centre` is a sole, and a sole standing on this board sits within a few centimetres of its top face. An
     * earlier version allowed 2.5 m above it — picked when a body's position was being passed rather than a
     * foot — which pressed every key under a player still falling two metres up.
     *
     * Some slack either way is still needed: the gait lifts and plants continuously, so a foot mid-plant is
     * fractionally above the surface it is about to be on.
     */
    if (Math.abs(local.y - board.half.y) > reach) continue

    // Inverting exactly the arithmetic `capsFor` used. Two different copies of that rule is how a press lands
    // beside the foot instead of under it.
    const cellOf = (v: number, start: number): number => (v - start) / board.pitch
    const lo = (v: number, start: number): number => Math.max(0, Math.ceil(cellOf(v - radius, start)))
    const hi = (v: number, start: number, count: number): number => Math.min(count - 1, Math.floor(cellOf(v + radius, start)))

    for (let c = lo(local.x, board.startX); c <= hi(local.x, board.startX, board.cols); c += 1)
      for (let r = lo(local.z, board.startZ); r <= hi(local.z, board.startZ, board.rows); r += 1) {
        const dx = board.startX + c * board.pitch - local.x
        const dz = board.startZ + r * board.pitch - local.z
        // Against the cap's own half-width too, so a cap the footprint merely clips still goes down.
        if (Math.hypot(dx, dz) > radius + board.pitch / 2) continue
        const cap = caps.get(`${b}:${c}:${r}`)
        if (cap !== undefined) found.push(cap)
      }
    // One board per footprint: boards do not overlap, and stopping here keeps a long level cheap.
    if (found.length > 0) return found
  }
  return found
}

/** The `Keyboard` params on the node a visual belongs to, or `null` if it is not a board. */
const keyboardOn = (loaded: LoadedLevel, item: VisualItem): KeyboardParams | null => {
  const handle = item.colliderHandles[0]
  const node = handle === undefined ? undefined : loaded.nodeOf(handle)
  if (node === undefined) return null
  const data = node.components.find((c) => c.type === Keyboard.type && c.enabled !== false)
  if (data === undefined) return null
  const p = data.params as Partial<KeyboardParams>
  return {
    pitch: numberOr(p.pitch, 0.9),
    fill: numberOr(p.fill, 0.88),
    height: numberOr(p.height, 0.45),
    glyphs: typeof p.glyphs === 'string' && p.glyphs.length > 0 ? p.glyphs : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    seed: numberOr(p.seed, 1),
  }
}

export interface KeyboardParams {
  pitch: number
  fill: number
  height: number
  glyphs: string
  seed: number
}

const numberOr = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/**
 * One board's frame and grid.
 *
 * The grid is **centred on the face**: the leftover from dividing the face by the pitch is split between the
 * two edges, so a board never has caps hanging over the side.
 */
export const boardOf = (item: Pick<VisualItem, 'collider' | 'position' | 'rotation'>, params: KeyboardParams): Board | null => {
  if (item.collider.kind !== 'box') return null
  const half = item.collider.halfExtents
  const cols = Math.floor((half.x * 2) / params.pitch)
  const rows = Math.floor((half.z * 2) / params.pitch)
  if (cols < 1 || rows < 1) return null
  const quat = new THREE.Quaternion(item.rotation.x, item.rotation.y, item.rotation.z, item.rotation.w)
  return {
    origin: new THREE.Vector3(item.position.x, item.position.y, item.position.z),
    quat,
    inverse: quat.clone().invert(),
    half,
    pitch: params.pitch,
    startX: -((cols - 1) * params.pitch) / 2,
    startZ: -((rows - 1) * params.pitch) / 2,
    cols,
    rows,
  }
}

/**
 * Every cap on one board's top face, in world space.
 *
 * Laid out in the box's own frame and then rotated with it, so a tilted platform gets a tilted board rather
 * than caps hanging in the air. Only box colliders tile: a sphere or a capsule has no face to tile, and a
 * convex hull has no cheap answer.
 */
export const capsFor = (
  board: Board,
  half: Vec3,
  params: KeyboardParams,
): { glyph: string; col: number; row: number; matrix: THREE.Matrix4 }[] => {
  const size = params.pitch * params.fill
  const out: { glyph: string; col: number; row: number; matrix: THREE.Matrix4 }[] = []
  for (let c = 0; c < board.cols; c += 1)
    for (let r = 0; r < board.rows; r += 1) {
      // `half.y` and not `half.y + height / 2`: the cap's geometry runs y 0…1 from its own base, so its origin
      // belongs **on** the platform's face rather than half a cap above it.
      const local = new THREE.Vector3(board.startX + c * params.pitch, half.y, board.startZ + r * params.pitch)
      const world = local.applyQuaternion(board.quat).add(board.origin)
      const matrix = new THREE.Matrix4().compose(world, board.quat, new THREE.Vector3(size, params.height, size))
      const glyph = params.glyphs[glyphAt(params.seed, c, r, params.glyphs.length)] ?? 'A'
      out.push({ glyph, col: c, row: r, matrix })
    }
  return out
}

/**
 * Which glyph a cell gets: a hash of the seed and the cell, not a random number.
 *
 * Deterministic on purpose. Every client builds its own caps from the same level, so a shared hash means two
 * players looking at the same key see the same letter — and a level looks the same every time it is opened.
 */
export const glyphAt = (seed: number, col: number, row: number, count: number): number => {
  let h = (seed * 0x9e3779b1) ^ (col * 0x85ebca6b) ^ (row * 0xc2b2ae35)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return Math.abs(h ^ (h >>> 15)) % count
}

/**
 * The cap's surface: **two square tiles**, the legend on the left and flat cap colour on the right.
 *
 * The geometry's UVs send the top face across the left tile and every wall vertex to one point in the right
 * one, so the letter appears only on the top. One texture rather than two materials, because an instanced mesh
 * takes exactly one.
 *
 * Drawn on a canvas, which is the same trick the nametags use.
 */
const glyphTexture = (glyph: string, look: KeycapLook): THREE.Texture => {
  const tile = 128
  const canvas = document.createElement('canvas')
  canvas.width = tile * 2
  canvas.height = tile
  const ctx = canvas.getContext('2d')
  if (ctx !== null) {
    ctx.fillStyle = `#${look.cap.toString(16).padStart(6, '0')}`
    ctx.fillRect(0, 0, tile * 2, tile)
    ctx.fillStyle = `#${look.ink.toString(16).padStart(6, '0')}`
    ctx.font = `600 ${tile * 0.46}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    // Up and left of centre, where a keycap's legend actually sits — the dish makes dead centre read low.
    ctx.fillText(glyph, tile * 0.38, tile * 0.4)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  // The top face samples right up to the tile's edge; without this it bleeds into the blank tile beside it.
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.anisotropy = 4
  return texture
}
