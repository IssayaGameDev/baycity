import { shapeEdges, THREE } from '@mp/render-three'

/**
 * My selection's edges (ADR 0146): thin white lines where a shape's faces meet, on every mesh of the selected
 * subtrees, wherever they can be seen. On top of the outline (ADR 0145), which is the shape; these are its
 * edges. Mine only — on five people's selections they would be clutter, and theirs are told apart by colour.
 *
 * Each line copies its mesh's world matrix every frame, so it follows a drag, the Motion preview and a
 * collaborator's pose with no bookkeeping. The set is rebuilt only when the meshes under the selection change:
 * a new selection, or a rebuild that replaced them. The lines live in their own group outside the item groups,
 * which is what keeps a click from ever landing on one.
 */

export interface SelectionEdgesHost {
  scene: THREE.Scene
  selection: () => readonly number[]
  groupAt: (i: number) => THREE.Group | undefined
  /** Play mode: the viewport is the game's, so none. */
  playing: () => boolean
}

export interface SelectionEdges {
  /** Once per frame: follow the meshes, and rebuild when they changed. */
  frame: () => void
}

const MATERIAL = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthWrite: false })
/**
 * A hair toward the eye, so an edge lying exactly on its own faces wins against them instead of flickering.
 * Lines take no polygon offset, so it is done where the vertex is projected: a thousandth of the distance in
 * perspective — 5 cm at 50 m, thinner than anything a level is built of at the range it is edited from — and
 * 2 cm along the view in orthographic, where depth is linear and scaling toward the eye would move the line
 * sideways.
 */
MATERIAL.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader.replace(
    '#include <project_vertex>',
    `#include <project_vertex>
  if (isPerspectiveMatrix(projectionMatrix)) mvPosition.xyz *= 0.999;
  else mvPosition.z += 0.02;
  gl_Position = projectionMatrix * mvPosition;`,
  )
}

/** Is it drawn: itself and every ancestor visible. */
const shown = (o: THREE.Object3D): boolean => {
  for (let at: THREE.Object3D | null = o; at !== null; at = at.parent) if (!at.visible) return false
  return true
}

/**
 * The meshes whose edges are drawn: every mesh of the selected subtrees, but not a board's surface cells (a
 * grid of flat squares, not an edge of the shape) nor a light's wireframe gizmo, which is lines already.
 */
const meshesUnder = (roots: readonly THREE.Object3D[]): THREE.Mesh[] => {
  const out: THREE.Mesh[] = []
  for (const root of roots)
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || o instanceof THREE.InstancedMesh) return
      const materials = Array.isArray(o.material) ? o.material : [o.material]
      if (materials.some((m) => (m as THREE.MeshBasicMaterial).wireframe === true)) return
      out.push(o)
    })
  return out
}

export const createSelectionEdges = (host: SelectionEdgesHost): SelectionEdges => {
  const overlay = new THREE.Group()
  overlay.name = 'selection-edges'
  host.scene.add(overlay)
  let drawn: { mesh: THREE.Mesh; line: THREE.LineSegments | null }[] = []

  const rebuild = (meshes: readonly THREE.Mesh[]): void => {
    for (const d of drawn) {
      if (d.line === null) continue
      overlay.remove(d.line)
      d.line.geometry.dispose()
    }
    drawn = meshes.map((mesh) => {
      const edges = shapeEdges(mesh.geometry)
      if (edges === null) return { mesh, line: null }
      const line = new THREE.LineSegments(edges, MATERIAL)
      line.matrixAutoUpdate = false
      // Its matrix is set by hand each frame, so its bounds would be stale for culling.
      line.frustumCulled = false
      overlay.add(line)
      return { mesh, line }
    })
  }

  return {
    frame: () => {
      const roots = host.playing() ? [] : host.selection().flatMap((i) => host.groupAt(i) ?? [])
      const meshes = meshesUnder(roots)
      if (meshes.length !== drawn.length || meshes.some((m, n) => drawn[n]!.mesh !== m)) rebuild(meshes)
      for (const d of drawn) {
        if (d.line === null) continue
        d.line.visible = shown(d.mesh)
        // This frame's pose, not the last one the renderer composed: a drag or the preview may have moved it.
        d.mesh.updateWorldMatrix(true, false)
        d.line.matrix.copy(d.mesh.matrixWorld)
        d.line.matrixWorldNeedsUpdate = true
      }
    },
  }
}
