import * as THREE from 'three'

/**
 * A shape's edges as line segments, for the editor's selection (ADR 0146): where a box's faces meet, not every
 * triangle.
 *
 * `EdgesGeometry` finds them from the faces' angles, and that is right for everything but a rounded box: a box
 * gives its 12 edges, a cylinder its two rims, a sphere or a capsule nothing — it has no edges, and the outline
 * already shows its shape. A rounded box's bevel is facets a little over 20° apart, so the angle either finds
 * no edge at all or a band of five lines along each; it gets **one line along the middle of each rounded
 * edge** instead, from the size and radius `materials.ts` records on it.
 */

/** What `materials.ts` records on a rounded box it builds, since three keeps neither. */
export interface RoundedBoxInfo {
  readonly width: number
  readonly height: number
  readonly depth: number
  readonly radius: number
}

/** A crease between two faces at least this sharp is an edge. Below a capsule's facets, above nothing real. */
export const EDGE_ANGLE_DEG = 20

const roundedBoxEdges = (b: RoundedBoxInfo): THREE.BufferGeometry => {
  const half = [b.width / 2, b.height / 2, b.depth / 2] as const
  const r = b.radius
  // Where each rounded edge's arc is at 45°: its centre line, on the surface.
  const out = half.map((h) => h - r + r * Math.SQRT1_2)
  const straight = half.map((h) => h - r)
  const points: number[] = []
  for (let along = 0; along < 3; along++) {
    const [a, c] = [0, 1, 2].filter((k) => k !== along) as [number, number]
    // A side with no straight part left has no edge to run along.
    if (straight[along]! <= 1e-6) continue
    for (const sa of [-1, 1])
      for (const sc of [-1, 1])
        for (const end of [-1, 1]) {
          const p = [0, 0, 0]
          p[along] = end * straight[along]!
          p[a] = sa * out[a]!
          p[c] = sc * out[c]!
          points.push(p[0]!, p[1]!, p[2]!)
        }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
  return g
}

/** The edges of `geometry` in its own space, or `null` when it has none. */
export const shapeEdges = (geometry: THREE.BufferGeometry): THREE.BufferGeometry | null => {
  const rounded = geometry.userData.roundedBox as RoundedBoxInfo | undefined
  const edges = rounded !== undefined ? roundedBoxEdges(rounded) : new THREE.EdgesGeometry(geometry, EDGE_ANGLE_DEG)
  if (edges.getAttribute('position').count > 0) return edges
  edges.dispose()
  return null
}
