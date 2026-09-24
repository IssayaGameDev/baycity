// @vitest-environment happy-dom
import { COLLIDER, SEQUENCE, type ComponentData, type Level, type Stage, type Step } from '@mp/content'
import { ENGINE_COMPONENTS, GAMEPLAY_COMPONENTS, createRegistry } from '@mp/components'
import { vec3, type Vec3 } from '@mp/core'
import { THREE } from '@mp/render-three'
import { describe, expect, it } from 'vitest'

import { levelDoc, type Doc } from './editorDoc'
import type { OpenPoint } from './inspector'
import { createPointTool } from './pointTool'

/**
 * A move point in the viewport (ADR 0144): the copy stands where the open step puts the object, dragging it
 * writes the step's point as one edit, and the route runs through the points in play order.
 */

const REG = createRegistry([...ENGINE_COMPONENTS, ...GAMEPLAY_COMPONENTS])
const move = (id: string, to: Vec3): Step => ({ id, kind: 'move', to, timing: { by: 'seconds', seconds: 1 }, ease: 'linear' })
const STAGES: readonly Stage[] = [
  { id: 'A', steps: [move('m', vec3(0, 0, 2))] },
  { id: 'B', steps: [move('n', vec3(0, 0, 4))] },
]
const box: ComponentData = { id: 'c', type: COLLIDER, params: { shape: { kind: 'box', halfExtents: vec3(0.5, 0.5, 0.5) } } }
const seq: ComponentData = { id: 'seq', type: SEQUENCE, params: { name: '', clock: 'shared', axes: 'object', loop: 'restart', times: 0, offset: 0, stages: STAGES } }
const OPEN: OpenPoint = { node: 0, componentId: 'seq', stepId: 'm' }

const expectVec = (got: Vec3, want: Vec3): void => {
  expect(got.x).toBeCloseTo(want.x, 6)
  expect(got.y).toBeCloseTo(want.y, 6)
  expect(got.z).toBeCloseTo(want.z, 6)
}

/** A level of one box at (5, 0, 0) turned a quarter about Y, drawn the way `itemMeshes.ts` draws it. */
const rig = (open: OpenPoint | null = OPEN) => {
  const level: Level = { id: 'lv', config: {}, nodes: [{ id: 'p', name: 'p', transform: { position: vec3(5, 0, 0), rotation: vec3(0, Math.PI / 2, 0) }, components: structuredClone([box, seq]) }] }
  const doc: Doc = levelDoc(level, REG)
  const scene = new THREE.Scene()
  const root = new THREE.Group()
  scene.add(root)
  const groups: THREE.Group[] = []
  for (let i = 0; i < doc.count(); i++) {
    const g = new THREE.Group()
    const t = doc.transformOf(i)
    const r = t.rotation ?? vec3(0, 0, 0)
    g.position.set(t.position.x, t.position.y, t.position.z)
    g.quaternion.setFromEuler(new THREE.Euler(r.x, r.y, r.z, 'XYZ'))
    const holder = new THREE.Group()
    holder.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)))
    g.userData.meshes = holder
    g.add(holder)
    root.add(g)
    groups.push(g)
  }
  const state = { open, snap: false, begun: 0, ended: [] as string[], reattached: 0, dragged: false }
  const camera = new THREE.PerspectiveCamera()
  const tool = createPointTool({
    camera,
    canvas: document.createElement('canvas'),
    controls: { enabled: true },
    scene,
    doc: () => doc,
    selection: () => [0],
    groupAt: (i) => groups[i],
    holderOf: (g) => g.userData.meshes as THREE.Group,
    openPoint: () => state.open,
    activeCamera: () => camera,
    playing: () => false,
    motionPlaying: () => false,
    space: () => 'world',
    snapping: () => state.snap,
    snapStep: () => 0.5,
    edits: () => ({ beginDrag: () => void (state.begun += 1), endDrag: (label) => void state.ended.push(label) }),
    setDragged: (value) => void (state.dragged = value),
    reattachGizmo: () => void (state.reattached += 1),
    inspectorRebuild: () => tool.refresh(),
    afterDrag: () => {},
  })
  tool.refresh()
  const overlay = scene.getObjectByName('sequence-points')!
  const copy = (): THREE.Object3D | undefined => overlay.children.find((c) => c instanceof THREE.Group)
  const pointOf = (id: string): Vec3 => {
    const stages = doc.components(0).find((c) => c.id === 'seq')!.params.stages as Stage[]
    const step = stages.flatMap((s) => s.steps).find((s) => s.id === id)!
    return step.kind === 'move' ? step.to : vec3(NaN, NaN, NaN)
  }
  /** A drag of the copy's handles to a place in the world, as `TransformControls` reports one. */
  const drag = (to: Vec3): void => {
    tool.control.dispatchEvent({ type: 'dragging-changed', value: true })
    copy()!.position.set(to.x, to.y, to.z)
    tool.control.dispatchEvent({ type: 'objectChange' })
    tool.control.dispatchEvent({ type: 'dragging-changed', value: false })
  }
  return { tool, state, overlay, copy, pointOf, drag }
}

describe('the copy', () => {
  it('stands where the open step puts the object, in the object’s own axes, with the handles on it', () => {
    const r = rig()
    const copy = r.copy()!
    // (0, 0, 2) along an object turned a quarter about Y is two metres along the level's X.
    expectVec(copy.position, vec3(7, 0, 0))
    expect(r.tool.control.object).toBe(copy)
    expect(r.tool.editing()).toBe(true)
    expect(r.state.reattached, 'the object’s own gizmo gave way').toBe(1)
  })

  it('writes where it is dragged back as the step’s point, as one edit', () => {
    const r = rig()
    r.drag(vec3(7, 3, 0))
    expect(r.pointOf('m')).toEqual(vec3(0, 3, 2))
    expect(r.pointOf('n'), 'no other step moves').toEqual(vec3(0, 0, 4))
    expect([r.state.begun, r.state.ended]).toEqual([1, ['move point']])
    expect(r.state.dragged, 'the release is not a click').toBe(true)
  })

  it('snaps its corner to the grid, as any move does', () => {
    const r = rig()
    r.state.snap = true
    r.drag(vec3(7.2, 3.1, 0.1))
    expect(r.pointOf('m')).toEqual(vec3(0, 3, 2))
  })

  it('goes, and gives the object its gizmo back, when the step closes', () => {
    const r = rig()
    r.state.open = null
    r.tool.refresh()
    expect(r.copy()).toBeUndefined()
    expect(r.tool.control.object).toBeUndefined()
    expect(r.state.reattached).toBe(2)
  })
})

describe('the route', () => {
  it('runs from where the object was placed through its points in play order, a numbered dot at each', () => {
    const r = rig(null)
    const line = r.overlay.children.find((c): c is THREE.Line => c instanceof THREE.Line)!
    expect([...(line.geometry.getAttribute('position').array as Float32Array)]).toEqual([5, 0, 0, 7, 0, 0, 9, 0, 0].map((v) => expect.closeTo(v, 5)))
    const dots = r.overlay.children.filter((c) => c instanceof THREE.Sprite)
    expect(dots.map((d) => d.position.x)).toEqual([7, 9].map((v) => expect.closeTo(v, 6)))
  })
})
