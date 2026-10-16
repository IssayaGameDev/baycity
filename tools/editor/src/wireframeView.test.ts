import { THREE, geometryForBuiltin } from '@mp/render-three'
import { describe, expect, it } from 'vitest'

import { createWireframe } from './wireframeView'

/** The wireframe view (ADR 0227): every object's edges over the normal view, kept up as objects come and go. */

const box = (): THREE.Mesh => new THREE.Mesh(geometryForBuiltin('builtin:box', { x: 1, y: 1, z: 1 }), new THREE.MeshStandardMaterial())
const rig = () => {
  const scene = new THREE.Scene()
  const root = new THREE.Group()
  scene.add(root)
  const a = new THREE.Group()
  const holder = new THREE.Group()
  holder.add(box())
  // A light's gizmo, a wireframe already, and a board's cells, which are not the shape's edges.
  holder.add(new THREE.Mesh(new THREE.SphereGeometry(0.2), new THREE.MeshBasicMaterial({ wireframe: true })))
  holder.add(new THREE.InstancedMesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial(), 4))
  a.add(holder)
  root.add(a)
  const state = { playing: false }
  const wire = createWireframe({ scene, root: () => root, playing: () => state.playing })
  const lines = (): THREE.LineSegments[] => scene.getObjectByName('wireframe')!.children.filter((c): c is THREE.LineSegments => c instanceof THREE.LineSegments)
  return { root, a, state, wire, lines }
}

describe('the wireframe view', () => {
  it('draws nothing until it is on, then every object’s edges — not a gizmo’s, not a board’s cells', () => {
    const r = rig()
    r.wire.frame()
    expect(r.lines()).toHaveLength(0)
    r.wire.setOn(true)
    r.wire.frame()
    expect(r.lines()).toHaveLength(1)
    expect(r.lines()[0]!.geometry.getAttribute('position').count).toBe(24)
  })

  it('adds a line for an object that comes, drops a gone one’s, and shares a geometry’s edges', () => {
    const r = rig()
    r.wire.setOn(true)
    r.wire.frame()
    const b = new THREE.Group()
    // A second object drawing the very same geometry, as two placements of one model do.
    const first = r.lines()[0]!
    const shared = (r.a.children[0]!.children[0] as THREE.Mesh).geometry
    b.add(new THREE.Mesh(shared, new THREE.MeshStandardMaterial()))
    r.root.add(b)
    r.wire.frame()
    expect(r.lines()).toHaveLength(2)
    expect(r.lines()[1]!.geometry, 'one geometry’s edges, worked out once').toBe(first.geometry)
    r.root.remove(r.a)
    r.wire.frame()
    expect(r.lines()).toHaveLength(1)
  })

  it('follows its object, and hides with it', () => {
    const r = rig()
    r.wire.setOn(true)
    r.a.position.set(-5, 2, 0)
    r.wire.frame()
    const at = new THREE.Vector3().setFromMatrixPosition(r.lines()[0]!.matrix)
    expect([at.x, at.y, at.z]).toEqual([-5, 2, 0])
    r.a.visible = false
    r.wire.frame()
    expect(r.lines()[0]!.visible).toBe(false)
  })

  it('is gone while playing and when turned off', () => {
    const r = rig()
    r.wire.setOn(true)
    r.wire.frame()
    r.state.playing = true
    r.wire.frame()
    expect(r.lines()).toHaveLength(0)
    r.state.playing = false
    r.wire.frame()
    expect(r.lines()).toHaveLength(1)
    r.wire.setOn(false)
    r.wire.frame()
    expect(r.lines()).toHaveLength(0)
  })
})
