import { THREE } from '@mp/render-three'

/**
 * A keycap, as geometry (ADR 0069).
 *
 * Four things make a cap read as a cap rather than as a small box: a **taper** (the top face is smaller than
 * the base), a **dished top** (shallow and concave), **rounded corners**, and a **legend on the top only**. All
 * four are arithmetic, which is why this is generated rather than a model — taper, dish and roundness stay
 * parameters instead of being baked into a file, and the asset pipeline stays out of it.
 *
 * Built as a **unit cap**: x and z in −0.5…0.5, y in 0…1, so an instance matrix scales it by
 * `(capSize, capHeight, capSize)` and positions it with its base exactly on the platform's face.
 *
 * **No bottom face.** A cap sits on a platform and its underside is never seen, so it is about 30 triangles
 * that would only ever be back-faces.
 */
export interface KeycapShape {
  /** Top face width as a fraction of the base. Real caps sit around 0.78–0.85. */
  taper: number
  /** How deep the scoop in the top is, as a fraction of the cap's height. */
  dish: number
  /**
   * Corner rounding, as a superellipse exponent.
   *
   * 2 is a circle, 4 a squircle, and large numbers approach a square. A superellipse rather than four arcs and
   * four straight edges because it is one expression, has no seams to get wrong, and gives a keycap's
   * continuously-curved corner for free.
   */
  roundness: number
  /**
   * Points around the perimeter.
   *
   * **Instancing does not make triangles free.** The geometry is uploaded once, but every instance is drawn in
   * every pass — and there are three: the shadow map, the GTAO prepass and the colour pass. At 32 segments and
   * 4 dish rings a cap was 352 triangles, so a 364-cap level submitted 384k a frame for the keys alone. 12
   * segments is 84 a cap, and at 0.6 m across a squircle sampled 12 times still reads as round.
   */
  segments: number
  /** Rings across the dished top. 2 is enough for the scoop to shade at this size. */
  dishRings: number
}

export const DEFAULT_KEYCAP_SHAPE: KeycapShape = { taper: 0.82, dish: 0.28, roundness: 5, segments: 12, dishRings: 2 }

/**
 * Where on the texture each part of the cap looks.
 *
 * The texture is two square tiles side by side: the **legend** on the left, flat cap colour on the right. The
 * top face maps across the left tile, and every wall vertex samples the **same single point** in the right
 * one — so the sides are flat colour with nothing to stretch, and the letter appears only where a letter
 * belongs. That is the fix for the box version, where one instanced material meant the glyph appeared on all
 * six faces.
 */
const WALL_U = 0.75
const WALL_V = 0.5

/** A point on the rounded-square outline, at half-extent 0.5. */
const outline = (t: number, roundness: number): { x: number; z: number } => {
  const c = Math.cos(t)
  const s = Math.sin(t)
  const e = 2 / roundness
  return {
    x: 0.5 * Math.sign(c) * Math.abs(c) ** e,
    z: 0.5 * Math.sign(s) * Math.abs(s) ** e,
  }
}

export const keycapGeometry = (shape: KeycapShape = DEFAULT_KEYCAP_SHAPE): THREE.BufferGeometry => {
  const { taper, dish, roundness, segments, dishRings } = shape
  const position: number[] = []
  const uv: number[] = []
  const index: number[] = []

  const ring = Array.from({ length: segments }, (_, i) => outline((i / segments) * Math.PI * 2, roundness))
  /** Height of the top *rim*. The dish falls away from it toward the centre. */
  const rimY = 1

  // --- the wall -------------------------------------------------------------------------------------------
  // Its own vertices, not shared with the top: a shared rim would average the two normals and round off the
  // edge that gives a cap its defined lip.
  const wallBase = 0
  for (const p of ring) {
    position.push(p.x, 0, p.z)
    uv.push(WALL_U, WALL_V)
  }
  for (const p of ring) {
    position.push(p.x * taper, rimY, p.z * taper)
    uv.push(WALL_U, WALL_V)
  }
  for (let i = 0; i < segments; i += 1) {
    const j = (i + 1) % segments
    const b0 = wallBase + i
    const b1 = wallBase + j
    const t0 = wallBase + segments + i
    const t1 = wallBase + segments + j
    index.push(b0, t0, t1, b0, t1, b1)
  }

  // --- the dished top -------------------------------------------------------------------------------------
  // Concentric rings from the rim inward, then a single centre vertex. `y` is parabolic in the radial
  // fraction: level with the rim at the edge, `dish` below it at the middle. A sphere would be more correct
  // and is indistinguishable at 0.6 m.
  const topBase = position.length / 3
  for (let r = 0; r <= dishRings; r += 1) {
    const f = 1 - r / (dishRings + 1) // 1 at the rim, never quite 0 — the centre vertex is added after
    const y = rimY - dish * (1 - f * f)
    for (const p of ring) {
      const x = p.x * taper * f
      const z = p.z * taper * f
      position.push(x, y, z)
      /**
       * Planar, across the legend tile: the letter sits centred on the top however tapered the cap is.
       *
       * **`u` runs against `x`.** A player runs along +z with the camera behind them, so the camera looks
       * along +z with up +y — which puts screen-right at world **−x**. Mapping u up with x therefore draws every
       * letter mirrored. `v` runs with z for the same reason and needs no flip: world +z is away from the
       * camera, which is up the screen, and `CanvasTexture` already flips the canvas so v 1 is its top row.
       */
      uv.push((1 - (x / (0.5 * taper) + 1) / 2) * 0.5, (z / (0.5 * taper) + 1) / 2)
    }
  }
  const centre = position.length / 3
  position.push(0, rimY - dish, 0)
  uv.push(0.25, 0.5)

  for (let r = 0; r < dishRings; r += 1)
    for (let i = 0; i < segments; i += 1) {
      const j = (i + 1) % segments
      const o0 = topBase + r * segments
      const o1 = topBase + (r + 1) * segments
      index.push(o0 + i, o1 + i, o1 + j, o0 + i, o1 + j, o0 + j)
    }
  const innermost = topBase + dishRings * segments
  for (let i = 0; i < segments; i += 1) index.push(innermost + i, centre, innermost + ((i + 1) % segments))

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geometry.setIndex(index)
  // Derived rather than authored: the dish and the taper both bend the surface, and the wall/top split above
  // is what keeps this from smoothing the lip away.
  geometry.computeVertexNormals()
  return geometry
}
