import { THREE, geometryForBuiltin } from '@mp/render-three'
import { describe, expect, it } from 'vitest'

import { createSelectionEdges } from './selectionEdges'

/** My selection's edges (ADR 0146): on what is selected, following it, and gone with it. */

const rig = () => {
  const scene = new THREE.Scene()
  const group = new THREE.Group()
  group.position.set(3, 0, 0)
  const holder = new THREE.Group()
  holder.add(new THREE.Mesh(geometryForBuiltin('builtin:box', { x: 1, y: 1, z: 1 }), new THREE.MeshStandardMaterial()))
  // A light's gizmo, which is a wireframe already, and a board's cells, which are not the shape's edges.
  holder.add(new THREE.Mesh(new THREE.SphereGeometry(0.2), new THREE.MeshBasicMaterial({ wireframe: true })))
  holder.add(new THREE.InstancedMesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial(), 4))
  group.add(holder)
  scene.add(group)
  const state = { selection: [0] as number[], playing: false }
  const edges = createSelectionEdges({ scene, selection: () => state.selection, groupAt: (i) => (i === 0 ? group : undefined), playing: () => state.playing })
  const lines = (): THREE.LineSegments[] => scene.getObjectByName('selection-edges')!.children.filter((c): c is THREE.LineSegments => c instanceof THREE.LineSegments)
  return { group, state, edges, lines }
}

describe('my selection’s edges', () => {
  it('draws the selected shape’s edges, not its gizmo’s or its cells', () => {
    const r = rig()
    r.edges.frame()
    expect(r.lines()).toHaveLength(1)
    expect(r.lines()[0]!.geometry.getAttribute('position').count).toBe(24)
  })

  it('follows the object as it moves, in the same frame', () => {
    const r = rig()
    r.edges.frame()
    r.group.position.set(-5, 2, 0)
    r.edges.frame()
    const at = new THREE.Vector3().setFromMatrixPosition(r.lines()[0]!.matrix)
    expect([at.x, at.y, at.z]).toEqual([-5, 2, 0])
  })

  it('goes with the selection, and while playing', () => {
    const r = rig()
    r.edges.frame()
    r.state.selection = []
    r.edges.frame()
    expect(r.lines()).toHaveLength(0)
    r.state.selection = [0]
    r.state.playing = true
    r.edges.frame()
    expect(r.lines()).toHaveLength(0)
  })
})
