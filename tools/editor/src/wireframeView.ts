import { shapeEdges, THREE } from '@mp/render-three'

import { edgeMaterial, meshesUnder, shown } from './selectionEdges'

/**
 * The wireframe view (ADR 0227, Kodjo's call: lines over the normal view): every object's edges, where its faces
 * meet — the selection's lines (ADR 0146) on everything, darker, so a selection's white ones stay told apart. Not
 * every triangle: a rounded box would be hatching. The viewer's own, not the room's; none while playing.
 *
 * Kept up as it goes, not rebuilt: each frame lists the meshes under the item root, makes a line for a new one and
 * drops a gone one's. A geometry's edges are worked out once, shared by every mesh drawing it, and let go of with it.
 * Each line copies its mesh's world matrix before the frame is drawn, so it follows a drag, the Motion preview and a
 * collaborator's pose; it is culled on its own bounds, which that matrix keeps true.
 */

export interface WireframeHost {
  scene: THREE.Scene
  /** Every item group hangs under this one. */
  root: () => THREE.Object3D
  /** Play mode: the viewport is the game's, so none. */
  playing: () => boolean
}

export interface Wireframe {
  /** Once per frame, before the draw: follow the meshes, and add or drop lines for what came or went. */
  frame: () => void
  on: () => boolean
  setOn: (on: boolean) => void
}

const MATERIAL = edgeMaterial(0x000000, 0.45)

export const createWireframe = (host: WireframeHost): Wireframe => {
  const overlay = new THREE.Group()
  overlay.name = 'wireframe'
  host.scene.add(overlay)
  let on = false
  /** The line drawn for each mesh, and the geometry it was made from; `null` line: a shape with no edges. */
  const drawn = new Map<THREE.Mesh, { geometry: THREE.BufferGeometry; line: THREE.LineSegments | null }>()
  const edgesOf = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry | null>()
  const edges = (g: THREE.BufferGeometry): THREE.BufferGeometry | null => {
    const have = edgesOf.get(g)
    if (have !== undefined) return have
    const made = shapeEdges(g)
    edgesOf.set(g, made)
    g.addEventListener('dispose', () => {
      made?.dispose()
      edgesOf.delete(g)
    })
    return made
  }
  const drop = (mesh: THREE.Mesh): void => {
    const d = drawn.get(mesh)
    if (d?.line) overlay.remove(d.line)
    drawn.delete(mesh)
  }

  return {
    on: () => on,
    setOn: (next) => {
      on = next
    },
    frame: () => {
      const showing = on && !host.playing()
      overlay.visible = showing
      if (!showing) {
        for (const mesh of [...drawn.keys()]) drop(mesh)
        return
      }
      const meshes = meshesUnder([host.root()])
      const now = new Set(meshes)
      for (const mesh of [...drawn.keys()]) if (!now.has(mesh)) drop(mesh)
      for (const mesh of meshes) {
        let d = drawn.get(mesh)
        if (d !== undefined && d.geometry !== mesh.geometry) {
          drop(mesh)
          d = undefined
        }
        if (d === undefined) {
          const e = edges(mesh.geometry)
          const line = e === null ? null : new THREE.LineSegments(e, MATERIAL)
          if (line !== null) {
            line.matrixAutoUpdate = false
            overlay.add(line)
          }
          d = { geometry: mesh.geometry, line }
          drawn.set(mesh, d)
        }
        if (d.line === null) continue
        d.line.visible = shown(mesh)
        mesh.updateWorldMatrix(true, false)
        d.line.matrix.copy(mesh.matrixWorld)
        d.line.matrixWorldNeedsUpdate = true
      }
    },
  }
}
