import type { Vec3 } from '@mp/core'
import type { LoadedLevel, VisualItem } from '@mp/content'
import type { SurfaceGrid, SurfaceGridOf } from '@mp/mode'
import { THREE } from '@mp/render-three'
import type { TpsClient } from '@mp/tps'

import { Keyboard } from './components/keyboard'
import { keyColoursAt, type KeyColours, type KeyStyleColours } from './keyColours'
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
 * - **No per-cap nodes.** Hundreds of nodes per platform would be unauthorable and unloadable. The component
 *   (`components/keyboard.ts`) is *data* on one node, and the caps are generated here.
 */

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

export const DEFAULT_PRESS: PressFeel = { depth: 0.7, downTime: 0.05, upTime: .65 }

export interface Keycaps {
  /**
   * Hold down every cap under this footprint.
   *
   * **Occupancy, not an event.** A cap is down for as long as somebody is standing over it and springs back
   * when they leave — so standing still leaves a print of your feet in the board rather than a key that bobs
   * once and pops up under you. Call it once per character per frame; anything not called for goes back up.
   *
   * `radius` is the character's footprint, so a 0.4 m capsule on the 0.9 m pitch holds one to four caps
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
  /** Set for a board a sequence carries (ADR 0154): where it is now, relative to where its caps were built. */
  moving?: Moving
}

/** A carried board's pose now, as the footfall lookup needs it (ADR 0154). */
export interface Moving {
  /** From where the board is now back to where its caps were built: what a foot is taken through. */
  toRest: THREE.Matrix4
  /** Switched off, or faded to nothing: nothing to stand on, and nothing to press. */
  hidden: boolean
}

/**
 * A board a sequence carries, or one under something a sequence carries (ADR 0154).
 *
 * Its caps are built where the board was at load, into the **riding** meshes, which tag every cap with the board
 * it rides. Each frame the board's row of one small texture says how far it has gone since — a transform and an
 * opacity — and the vertex shader carries every cap of it there. A moving board is one row a frame, however
 * many caps it has; a still board pays nothing for any of this.
 */
interface Riding {
  readonly item: VisualItem
  readonly board: Board & { moving: Moving }
  /** Where the board was built, inverted. */
  readonly restInverse: THREE.Matrix4
  /** How far it has gone: now × `restInverse`. What its row of the texture holds. */
  readonly delta: THREE.Matrix4
}

/** Texels per board in the state texture: four for the transform's columns, one for the opacity. */
const STATE_TEXELS = 5

/**
 * Where a carried board is now, from its visual: `delta` takes a cap from where it was built to where it is,
 * `toRest` back. `false` while the board is not drawn — switched off, or a fade at nothing, as the level view
 * decides for the platform itself — and then `delta` folds every cap to a point, so nothing is drawn or shaded.
 *
 * The pose is the level view's: `position`, `rotation`, and `drawScale` in the board's own frame.
 */
// Every carried board, every frame: reused rather than allocated.
const carryAt = new THREE.Vector3()
const carryTurn = new THREE.Quaternion()
const carryScale = new THREE.Vector3()

export const carry = (
  v: Pick<VisualItem, 'position' | 'rotation' | 'drawScale' | 'visible' | 'fades' | 'opacity'>,
  restInverse: THREE.Matrix4,
  delta: THREE.Matrix4,
  toRest: THREE.Matrix4,
): boolean => {
  const shown = v.visible && !(v.fades && v.opacity <= 0)
  if (!shown) {
    delta.makeScale(0, 0, 0)
    return false
  }
  delta
    .compose(
      carryAt.set(v.position.x, v.position.y, v.position.z),
      carryTurn.set(v.rotation.x, v.rotation.y, v.rotation.z, v.rotation.w),
      carryScale.set(v.drawScale.x, v.drawScale.y, v.drawScale.z),
    )
    .multiply(restInverse)
  toRest.copy(delta).invert()
  return true
}

/**
 * The riding meshes' shader: `MeshStandardMaterial`'s, with every cap carried by its board's row (ADR 0154).
 *
 * One substitution does the moving. `instanceMatrix` is what every chunk places a cap by — its position, its
 * normal, its world position for the shadows it receives — so defining it as the board's transform times the
 * cap's own, at the top of `main`, carries all of them at once without touching a chunk. The opacity rides a
 * varying into the colour. `texelFetch`, so WebGL 2, which three has required since r163.
 */
export const RIDING_VERTEX_HEAD = /* glsl */ `attribute float boardSlot;
uniform highp sampler2D boardState;
varying float vBoardOpacity;
mat4 boardInstance;
`
export const RIDING_VERTEX_MAIN = /* glsl */ `
  {
    int slot = int(boardSlot + 0.5);
    mat4 carried = mat4(
      texelFetch(boardState, ivec2(0, slot), 0),
      texelFetch(boardState, ivec2(1, slot), 0),
      texelFetch(boardState, ivec2(2, slot), 0),
      texelFetch(boardState, ivec2(3, slot), 0)
    );
    boardInstance = carried * instanceMatrix;
    vBoardOpacity = texelFetch(boardState, ivec2(4, slot), 0).r;
  }
#define instanceMatrix boardInstance
`

/**
 * Every cap's own colours (ADR 0182): the letter texture is a stencil — white letter, black elsewhere — and each cap
 * carries its cap and letter colours as two instance attributes, mixed by it. One shader for every key on every board,
 * so a palette costs no draw call; the walls sample the black tile, so they are the cap colour.
 */
export const PAINT_VERTEX_HEAD = /* glsl */ `attribute vec3 capColor;
attribute vec3 inkColor;
varying vec3 vCapColor;
varying vec3 vInkColor;
`

/** Patch a material's shader sources in place for painted caps. Throws if three's sources stop having the hooks. */
export const paintShader = (shader: { vertexShader: string; fragmentShader: string }): void => {
  if (!shader.vertexShader.includes('void main() {') || !shader.fragmentShader.includes('#include <map_fragment>')) {
    throw new Error('keycaps: the standard material shader changed; the paint patch no longer applies')
  }
  shader.vertexShader = PAINT_VERTEX_HEAD + shader.vertexShader.replace('void main() {', 'void main() {\n\tvCapColor = capColor;\n\tvInkColor = inkColor;')
  shader.fragmentShader = `varying vec3 vCapColor;\nvarying vec3 vInkColor;\n${shader.fragmentShader.replace(
    '#include <map_fragment>',
    '\tdiffuseColor.rgb *= mix(vCapColor, vInkColor, texture2D(map, vMapUv).r);',
  )}`
}

/** Patch a material's shader sources in place for riding caps. Throws if three's sources stop having the hooks. */
export const rideShader = (shader: { vertexShader: string; fragmentShader: string }): void => {
  if (!shader.vertexShader.includes('void main() {') || !shader.fragmentShader.includes('#include <color_fragment>')) {
    throw new Error('keycaps: the standard material shader changed; the riding patch no longer applies')
  }
  shader.vertexShader = RIDING_VERTEX_HEAD + shader.vertexShader.replace('void main() {', `void main() {${RIDING_VERTEX_MAIN}`)
  shader.fragmentShader = `varying float vBoardOpacity;\n${shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n\tdiffuseColor.a *= vBoardOpacity;')}`
}

/** One placed cap: where it rests, which instance draws it, and how far down it currently is. */
interface Cap {
  mesh: THREE.InstancedMesh
  index: number
  /** The board carrying it, when a sequence does: `rest` is where it was built, and this says where it is. */
  riding: Riding | null
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
 * **Per glyph, not per board**, and pooled across the whole level: 26 draw calls for every still keyboard in the
 * level put together, rather than one per cap, and up to 26 more for every board a sequence carries (ADR 0154). The alternative — one mesh with a per-instance UV offset into a
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
  /**
   * The key geometry, read from the game's settings by the caller (ADR 0115). A getter rather than a value:
   * the settings are editable live in the Game row, and the boards are rebuilt when they change.
   */
  keyGeometry: () => KeyGeometry = () => DEFAULT_KEY_GEOMETRY,
  /** A Keyboard Style's colours by asset id (ADR 0182), read by the caller; `undefined` for none, or not one. */
  styleOf: (assetId: string) => KeyStyleColours | undefined = () => undefined,
): Keycaps => {
  const meshes: THREE.InstancedMesh[] = []
  /** Undoes keeping each riding mesh out of the AO prepass (below). */
  const backIntoAO: (() => void)[] = []
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

  /** The boards a sequence carries, by their row in `state` (ADR 0154). */
  const riding: Riding[] = []
  /** One row per carried board: its transform's columns, then its opacity. `null` when nothing is carried. */
  let state: THREE.DataTexture | null = null
  /** What `state` uploads: kept typed here, since three types a texture's data loosely. */
  let stateData = new Float32Array(0)
  /** Each mesh's geometry: the cap's own attributes, shared, plus each cap's colours and, riding, its board. */
  const meshGeometries: THREE.BufferGeometry[] = []

  /** Write each carried board's row, and upload only when one of them moved. One row per board, per frame. */
  const follow = (): void => {
    if (state === null) return
    const data = stateData
    let changed = false
    riding.forEach((r, slot) => {
      const shown = carry(r.item, r.restInverse, r.delta, r.board.moving.toRest)
      r.board.moving.hidden = !shown
      const at = slot * STATE_TEXELS * 4
      const e = r.delta.elements
      for (let i = 0; i < 16; i += 1) {
        if (data[at + i] !== e[i]) {
          data[at + i] = e[i]!
          changed = true
        }
      }
      const opacity = shown ? r.item.opacity : 0
      if (data[at + 16] !== opacity) {
        data[at + 16] = opacity
        changed = true
      }
    })
    if (changed) state.needsUpdate = true
  }

  /** One cap to place: where it rests, which way its board faces down, its colours, and its board's row when carried. */
  interface Placed {
    key: string
    matrix: THREE.Matrix4
    down: THREE.Vector3
    slot: number
    colours: KeyColours
  }
  /** A board with no style, or none that reads: the plain look. */
  const plain: KeyColours = { cap: look.cap, ink: look.ink }

  const build = (loaded: LoadedLevel): void => {
    /**
     * Every cap, grouped by the letter on it — the still boards' apart from the carried ones', which go in
     * meshes of their own so that a still board pays nothing for boards that move.
     */
    const still = new Map<string, Placed[]>()
    const carried = new Map<string, Placed[]>()

    for (const item of loaded.visuals) {
      const params = keyboardOn(loaded, item, keyGeometry(), styleOf)
      if (params === null || item.collider.kind !== 'box') continue
      const board = boardOf(item, params)
      if (board === null) continue
      const boardIndex = boards.length
      boards.push(board)
      const down = new THREE.Vector3(0, -1, 0).applyQuaternion(board.quat)
      let slot = -1
      if (item.animated) {
        slot = riding.length
        const moving: Moving = { toRest: new THREE.Matrix4(), hidden: false }
        board.moving = moving
        const built = new THREE.Matrix4().compose(board.origin, board.quat, new THREE.Vector3(1, 1, 1))
        riding.push({ item, board: board as Board & { moving: Moving }, restInverse: built.invert(), delta: new THREE.Matrix4() })
      }
      const into = slot < 0 ? still : carried
      for (const cap of capsFor(board, item.collider.halfExtents, params)) {
        const list = into.get(cap.glyph) ?? []
        const colours = keyColoursAt(params.style, params.seed, cap.col, cap.row, plain)
        list.push({ key: `${boardIndex}:${cap.col}:${cap.row}`, matrix: cap.matrix, down, slot, colours })
        into.set(cap.glyph, list)
      }
    }

    if (riding.length > 0) {
      stateData = new Float32Array(riding.length * STATE_TEXELS * 4)
      state = new THREE.DataTexture(stateData, STATE_TEXELS, riding.length, THREE.RGBAFormat, THREE.FloatType)
      follow()
      state.needsUpdate = true
    }

    /** A letter's texture, shared by its still mesh and its riding one. */
    const glyphs = new Map<string, THREE.Texture>()
    const textureOf = (glyph: string): THREE.Texture => {
      let texture = glyphs.get(glyph)
      if (texture === undefined) {
        texture = glyphTexture(glyph)
        glyphs.set(glyph, texture)
        textures.push(texture)
      }
      return texture
    }

    const addMesh = (glyph: string, placed: readonly Placed[], rides: boolean): void => {
      const material = new THREE.MeshStandardMaterial({ map: textureOf(glyph), roughness: 0.5, metalness: 0 })
      // The cap's own attributes, shared rather than copied, plus each cap's two colours (ADR 0182) — and, riding,
      // the board it rides: four bytes a cap.
      const shape = new THREE.BufferGeometry()
      shape.setIndex(geometry.index)
      for (const [name, attribute] of Object.entries(geometry.attributes)) shape.setAttribute(name, attribute)
      const caps3 = new Float32Array(placed.length * 3)
      const inks3 = new Float32Array(placed.length * 3)
      const colour = new THREE.Color()
      placed.forEach((p, i) => {
        colour.setHex(p.colours.cap, THREE.SRGBColorSpace).toArray(caps3, i * 3)
        colour.setHex(p.colours.ink, THREE.SRGBColorSpace).toArray(inks3, i * 3)
      })
      shape.setAttribute('capColor', new THREE.InstancedBufferAttribute(caps3, 3))
      shape.setAttribute('inkColor', new THREE.InstancedBufferAttribute(inks3, 3))
      meshGeometries.push(shape)
      material.onBeforeCompile = paintShader
      if (rides) {
        /**
         * Transparent from the start, as a fadeable platform's own material is (ADR 0137), so a fade never
         * recompiles anything. At full opacity it draws as it would opaque.
         */
        material.transparent = true
        const texture = state!
        material.onBeforeCompile = (shader) => {
          shader.uniforms.boardState = { value: texture }
          paintShader(shader)
          rideShader(shader)
        }
        shape.setAttribute('boardSlot', new THREE.InstancedBufferAttribute(Float32Array.from(placed, (p) => p.slot), 1))
      }
      const mesh = new THREE.InstancedMesh(shape, material, placed.length)
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
        caps.set(p.key, { mesh, index: i, riding: p.slot < 0 ? null : riding[p.slot]!, rest, quat, scale, down: p.down, held: false, committed: false, at: 0 })
      })
      mesh.instanceMatrix.needsUpdate = true
      if (rides) {
        // Its caps are wherever their boards have gone, which bounds taken at load do not know.
        mesh.frustumCulled = false
        /**
         * **No ambient occlusion on a carried board's caps** (Kodjo's call). The AO prepass draws the scene with
         * one override material, which never gets the riding patch: it would see every cap where it was built,
         * at full strength — a dark ghost of the keys left behind by a move, and kept after a fade.
         */
        backIntoAO.push(client.excludeFromAO(mesh))
      } else {
        /**
         * Frustum culling needs the instances' bounds, not the geometry's.
         *
         * Without this Three culls against the **unit cap's** sphere sitting at the mesh's origin, which for a
         * board 40 m down the level is both wrong and useless: boards behind the camera were never skipped.
         * These instances do not move — a press travels 0.25 m — so this is computed once.
         */
        mesh.computeBoundingSphere()
      }
      client.scene.add(mesh)
      meshes.push(mesh)
    }

    for (const [glyph, placed] of still) addMesh(glyph, placed, false)
    for (const [glyph, placed] of carried) addMesh(glyph, placed, true)
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
          const top = new THREE.Vector3(cap.rest.x - cap.down.x * cap.scale.y, cap.rest.y - cap.down.y * cap.scale.y, cap.rest.z - cap.down.z * cap.scale.y)
          // Where a carried board's cap is now, not where it was built (ADR 0154).
          if (cap.riding !== null) top.applyMatrix4(cap.riding.delta)
          struck.push({ x: top.x, y: top.y, z: top.z })
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
       * read until then. The caps are laid out once; a board a sequence carries is followed every frame after.
       */
      if (boards.length === 0) {
        const loaded = client.level()
        if (loaded !== null) build(loaded)
        return
      }

      // Carried boards first, so a footfall this frame is looked up where the board is now.
      follow()
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
      for (const undo of backIntoAO) undo()
      backIntoAO.length = 0
      // Shared by every mesh, so disposed once rather than per glyph.
      geometry.dispose()
      for (const g of meshGeometries) g.dispose()
      state?.dispose()
      for (const texture of textures) texture.dispose()
      meshes.length = 0
      textures.length = 0
      boards.length = 0
      meshGeometries.length = 0
      riding.length = 0
      state = null
      stateData = new Float32Array(0)
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
    // A carried board (ADR 0154): nothing to press while it is not drawn, and the foot is taken back to where
    // the caps were built, so the arithmetic below is the one the placement used whatever the board has done.
    if (board.moving?.hidden === true) continue
    local.set(centre.x, centre.y, centre.z)
    if (board.moving !== undefined) local.applyMatrix4(board.moving.toRest)
    local.sub(board.origin).applyQuaternion(board.inverse)
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
    //
    // The candidates reach as far as the distance check below does — the footprint **plus half a cap**. They once
    // reached the footprint alone, which on the game's 0.9 m pitch (ADR 0115) is less than half a cell either
    // way: one key under a foot at most, and none within a few centimetres of the line between two.
    const cellOf = (v: number, start: number): number => (v - start) / board.pitch
    const reachOut = radius + board.pitch / 2
    const lo = (v: number, start: number): number => Math.max(0, Math.ceil(cellOf(v - reachOut, start)))
    const hi = (v: number, start: number, count: number): number => Math.min(count - 1, Math.floor(cellOf(v + reachOut, start)))

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
/**
 * The key geometry, shared by every board in the game (ADR 0115).
 *
 * Read from the game's settings, not from the component. `DEFAULT_KEY_GEOMETRY` is what a game that has never
 * set them gets, and it is the same three numbers the component used to declare.
 */
export interface KeyGeometry {
  pitch: number
  fill: number
  height: number
  /**
   * The most caps one board may carry; a bigger board carries none (ADR 0142).
   *
   * Not geometry, but read from the same settings and needed at the same place — `boardGrid`, the one rule
   * both the game and the editor's preview count cells with. A mistyped scale (800 000 m) once asked every
   * browser for tens of millions of caps and froze each one that opened the level.
   */
  maxKeys: number
}

export const DEFAULT_KEY_GEOMETRY: KeyGeometry = { pitch: 0.9, fill: 0.88, height: 0.45, maxKeys: 20_000 }

/**
 * The key numbers as editor settings (ADR 0087): one field each in the Game row, written to
 * `content/keyboard/game.json`. Changing the pitch is then one edit for the whole level rather than one per
 * platform. The budget is here so it can be raised without a deploy (ADR 0142).
 */
export const KEY_SETTINGS = {
  keyPitch: { kind: 'number', label: 'Key pitch m', hint: 'centre-to-centre spacing of the keys; the grid every board shares', default: 0.9, min: 0.05, max: 3, step: 0.01 },
  keyFill: { kind: 'number', label: 'Key fill', hint: 'cap footprint as a fraction of the pitch; the rest is the gap between keys', default: 0.88, min: 0.3, max: 1, step: 0.01 },
  keyHeight: { kind: 'number', label: 'Key height m', hint: 'how far a cap stands above the platform face', default: 0.45, min: 0.005, max: 1.5, step: 0.005 },
  keyBudget: { kind: 'number', label: 'Key budget', hint: 'most keys one board may carry; a bigger board gets none, in the game and in the preview', default: 20_000, min: 1_000, max: 100_000, step: 1_000 },
} as const

/**
 * This board's parameters: the game's geometry plus this surface's own lettering.
 *
 * A `pitch` still sitting in an old component's params is ignored — `readParams` walks the declarations, not
 * the file — so no level needed rewriting when the three moved (ADR 0115).
 */
const keyboardOn = (
  loaded: LoadedLevel,
  item: VisualItem,
  geometry: KeyGeometry,
  styleOf: (assetId: string) => KeyStyleColours | undefined = () => undefined,
): KeyboardParams | null => {
  const handle = item.colliderHandles[0]
  const node = handle === undefined ? undefined : loaded.nodeOf(handle)
  if (node === undefined) return null
  const data = node.components.find((c) => c.type === Keyboard.type && c.enabled !== false)
  if (data === undefined) return null
  const p = data.params as Partial<KeyboardParams>
  return {
    pitch: geometry.pitch,
    fill: geometry.fill,
    height: geometry.height,
    maxKeys: geometry.maxKeys,
    glyphs: typeof p.glyphs === 'string' && p.glyphs.length > 0 ? p.glyphs : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    seed: numberOr(p.seed, 1),
    facing: facingTurns(p.facing),
    style: typeof p.style === 'string' && p.style !== '' ? styleOf(p.style) : undefined,
  }
}

export interface KeyboardParams {
  pitch: number
  fill: number
  height: number
  maxKeys: number
  glyphs: string
  seed: number
  /** Quarter turns of the letters from forward, toward right (ADR 0182): 0 forward, 1 right, 2 back, 3 left. */
  facing: number
  /** The board's Keyboard Style's colours, read; `undefined` for the plain look. */
  style?: KeyStyleColours | undefined
}

/** The letters' facing as quarter turns: forward (blue +Z) is 0, then right (red +X), back, left; anything else forward. */
export const facingTurns = (facing: unknown): number => Math.max(0, ['forward', 'right', 'back', 'left'].indexOf(String(facing)))

const UP = new THREE.Vector3(0, 1, 0)

const numberOr = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/**
 * One board's frame and grid.
 *
 * The grid is **centred on the face**: the leftover from dividing the face by the pitch is split between the
 * two edges, so a board never has caps hanging over the side.
 */
/**
 * The board's frame from its box collider, with the caps **centred on the platform** (ADR 0118).
 *
 * Whole caps only, and the leftover split as margin, which is what it was before the world lattice of
 * ADR 0115. The lattice made two platforms continue each other, and it was reverted: it moved the caps off
 * centre on every platform, and getting a clean join then meant sizing and placing platforms to the grid
 * instead of the other way round. Corner snapping (ADR 0117) is the part of that attempt worth keeping.
 */
export const boardOf = (item: Pick<VisualItem, 'collider' | 'position' | 'rotation'>, params: KeyboardParams): Board | null => {
  if (item.collider.kind !== 'box') return null
  const half = item.collider.halfExtents
  const grid = boardGrid({ x: half.x * 2, y: half.y * 2, z: half.z * 2 }, params)
  if (grid === null) return null
  const quat = new THREE.Quaternion(item.rotation.x, item.rotation.y, item.rotation.z, item.rotation.w)
  return {
    origin: new THREE.Vector3(item.position.x, item.position.y, item.position.z),
    quat,
    inverse: quat.clone().invert(),
    half,
    pitch: grid.pitch,
    startX: grid.startX,
    startZ: grid.startZ,
    cols: grid.cols,
    rows: grid.rows,
  }
}

/**
 * The cell grid one box face carries, from its size alone (ADR 0120).
 *
 * Extracted from `boardOf` so the **editor** can draw the cells before the game has run without a second copy
 * of the rule — a preview computed its own way is a preview that can disagree with the runtime, which is the
 * fault ADR 0113, ADR 0114, ADR 0117 and ADR 0119 each fixed in turn.
 *
 * Whole cells only (ADR 0118), and the remainder split between the two edges, so a board never hangs over the
 * side. `null` for a face with no room for even one cell, which is what makes a Keyboard on a thin wall draw
 * nothing rather than one cap overhanging both ways.
 *
 * `size` is the box's **full extent** in metres, not its half-extents: it is what a node's scale is for a
 * built-in box (ADR 0090), which is the form the editor has and the form a person types.
 *
 * `null` too for a board over `maxKeys` (ADR 0142) — **none** rather than the first `maxKeys`, so an oversized
 * board reads as plain in the game and bare in the preview instead of half-tiled. Written as `!(… <= …)` so a
 * `NaN` or infinite size is refused as well: that is the input that reaches here when a scale is mistyped.
 */
export const boardGrid = (size: Vec3, geometry: KeyGeometry): SurfaceGrid | null => {
  if (!(geometry.pitch > 0)) return null
  const cols = Math.floor(size.x / geometry.pitch)
  const rows = Math.floor(size.z / geometry.pitch)
  if (cols < 1 || rows < 1) return null
  if (!(cols * rows <= geometry.maxKeys)) return null
  return {
    cols,
    rows,
    pitch: geometry.pitch,
    size: geometry.pitch * geometry.fill,
    startX: -((cols - 1) * geometry.pitch) / 2,
    startZ: -((rows - 1) * geometry.pitch) / 2,
  }
}

/**
 * The grid a node's own components put on its surface, or `null` — this game's `ModeDescriptor.surfaceGrid`.
 *
 * The editor asks per node and knows nothing about what a `Keyboard` is; the decision that this surface is a
 * board, and what its pitch is, stays here. `settings` are the editor's live values, so dragging the Key
 * pitch field re-lays every preview without a reload.
 */
export const keyboardGridOf: SurfaceGridOf = (components, size, settings) => {
  const data = components.find((c) => c.type === Keyboard.type && c.enabled !== false)
  if (data === undefined) return null
  return boardGrid(size, keyGeometryFrom(settings))
}

/**
 * The key geometry from a game's `settings`, with the declared defaults for anything unset (ADR 0115).
 *
 * Takes the values rather than reading the file, so the same function serves the game (its bundled
 * `game.json`) and the editor (the copy it is editing live).
 */
export const keyGeometryFrom = (settings: Readonly<Record<string, unknown>> | undefined): KeyGeometry => {
  const raw = settings ?? {}
  const num = (key: string, fallback: number): number => {
    const v = raw[key]
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback
  }
  return {
    pitch: num('keyPitch', DEFAULT_KEY_GEOMETRY.pitch),
    fill: num('keyFill', DEFAULT_KEY_GEOMETRY.fill),
    height: num('keyHeight', DEFAULT_KEY_GEOMETRY.height),
    maxKeys: num('keyBudget', DEFAULT_KEY_GEOMETRY.maxKeys),
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
  // The letters' facing (ADR 0182): the cap turned about the board's up, a quarter at a time — a cap is square, so
  // only its letter shows the turn.
  const turned = params.facing === 0 ? board.quat : board.quat.clone().multiply(new THREE.Quaternion().setFromAxisAngle(UP, (params.facing * Math.PI) / 2))
  for (let c = 0; c < board.cols; c += 1)
    for (let r = 0; r < board.rows; r += 1) {
      // `half.y` and not `half.y + height / 2`: the cap's geometry runs y 0…1 from its own base, so its origin
      // belongs **on** the platform's face rather than half a cap above it.
      const local = new THREE.Vector3(board.startX + c * params.pitch, half.y, board.startZ + r * params.pitch)
      const world = local.applyQuaternion(board.quat).add(board.origin)
      const matrix = new THREE.Matrix4().compose(world, turned, new THREE.Vector3(size, params.height, size))
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
const glyphTexture = (glyph: string): THREE.Texture => {
  const tile = 128
  const canvas = document.createElement('canvas')
  canvas.width = tile * 2
  canvas.height = tile
  const ctx = canvas.getContext('2d')
  if (ctx !== null) {
    // A stencil (ADR 0182): black is the cap, white the letter; each cap's own colours are mixed by it.
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, tile * 2, tile)
    ctx.fillStyle = '#ffffff'
    ctx.font = `600 ${tile * 0.46}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    // Up and left of centre, where a keycap's legend actually sits — the dish makes dead centre read low.
    ctx.fillText(glyph, tile * 0.38, tile * 0.4)
  }
  const texture = new THREE.CanvasTexture(canvas)
  // Data, not colour: a mix amount, read as it is.
  texture.colorSpace = THREE.NoColorSpace
  // The top face samples right up to the tile's edge; without this it bleeds into the blank tile beside it.
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.anisotropy = 4
  return texture
}
