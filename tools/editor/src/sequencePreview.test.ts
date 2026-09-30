import { COLLIDER, RENDERER, SEQUENCE, type ComponentData, type Level, type Node, type Stage, type Step } from '@mp/content'
import { ENGINE_COMPONENTS, SHARED_COMPONENTS, createRegistry } from '@mp/components'
import { axisAngleToQuat, eulerToQuat, mulQuat, quat, rotateVec3, vec3, type Quat, type Vec3 } from '@mp/core'
import { THREE } from '@mp/render-three'
import { describe, expect, it } from 'vitest'

import { levelDoc } from './editorDoc'
import { unpreviewed } from './gizmoTool'
import { createMotionPreview } from './motionPreview'

/**
 * The editor's preview of sequences (ADR 0141): what the Motion button shows, and what a drag mid-preview
 * writes back. The same rule the loader follows, read from the editor's document.
 */

const REG = createRegistry([...ENGINE_COMPONENTS, ...SHARED_COMPONENTS])
const ZERO: Vec3 = { x: 0, y: 0, z: 0 }
let n = 0
const id = (): string => `x${++n}`
const secs = (seconds: number): { by: 'seconds'; seconds: number } => ({ by: 'seconds', seconds })
const stage = (...steps: Step[]): Stage => ({ id: id(), steps })
const seq = (stages: Stage[]): ComponentData => ({ id: id(), type: SEQUENCE, params: { name: '', clock: 'shared', axes: 'object', loop: 'restart', times: 0, offset: 0, stages } })
const box: ComponentData[] = [
  { id: 'c', type: COLLIDER, params: { shape: { kind: 'box', halfExtents: vec3(0.5, 0.5, 0.5) } } },
  { id: 'r', type: RENDERER, params: { material: '' } },
]
const node = (nid: string, components: ComponentData[], extra: Partial<Node> = {}): Node => ({ id: nid, name: nid, transform: { position: ZERO }, components, ...extra })
const docOf = (nodes: Node[]) => levelDoc({ id: 'lv', config: {}, nodes } as Level, REG)

const expectVec = (got: Vec3, want: Vec3): void => {
  expect(got.x).toBeCloseTo(want.x, 9)
  expect(got.y).toBeCloseTo(want.y, 9)
  expect(got.z).toBeCloseTo(want.z, 9)
}
const expectSameTurn = (got: Quat, want: Quat): void => {
  for (const v of [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]) expectVec(rotateVec3(got, v), rotateVec3(want, v))
}

describe('the preview pose', () => {
  const everything = [
    stage(
      { id: id(), kind: 'move', to: vec3(0, 4, 0), timing: secs(2), ease: 'linear' },
      { id: id(), kind: 'turn', axis: vec3(0, 1, 0), angle: 90, timing: secs(2), ease: 'linear' },
      { id: id(), kind: 'scale', to: vec3(3, 1, 1), timing: secs(2), ease: 'linear' },
      { id: id(), kind: 'fade', to: 0, timing: secs(2), ease: 'linear' },
    ),
    stage({ id: id(), kind: 'enabled', on: false }),
    stage({ id: id(), kind: 'wait', seconds: 1 }),
  ]
  const placed = { position: vec3(5, 0, 0), rotation: vec3(0, 0, 0), scale: vec3(2, 2, 2) }

  it('moves, turns, scales and fades while sequences are shown', () => {
    const doc = docOf([node('p', [...box, seq(everything)], { transform: placed })])
    const pose = doc.posesAt(1000, { sequences: true })[0]!
    expectVec(pose.position, vec3(5, 2, 0))
    expectSameTurn(pose.turn, axisAngleToQuat(vec3(0, 1, 0), Math.PI / 4))
    expectVec(pose.scale, vec3(4, 2, 2)) // twice the authored 2 on x, halfway to three times
    expect(pose.opacity).toBeCloseTo(0.5, 9)
    expect(pose.shown).toBe(true)
    expect(doc.posesAt(2500, { sequences: true })[0]!.shown, 'disabled after the stage that says so').toBe(false)
  })

  /** Not previewing, an object is as it was set up: easy to see and click (ADR 0137). */
  it('shows the authored transform when sequences are not asked for', () => {
    const doc = docOf([node('p', [...box, seq(everything)], { transform: placed })])
    const pose = doc.posesAt(1000)[0]!
    expectVec(pose.position, vec3(5, 0, 0))
    expectVec(pose.scale, vec3(2, 2, 2))
    expect(pose.opacity).toBe(1)
    expect(pose.shown).toBe(true)
  })

  it('moves a child a parent’s step aims at, and disables a branch with its root', () => {
    const doc = docOf([
      node('door', [...box, seq([stage({ id: id(), kind: 'move', to: vec3(-2, 0, 0), timing: secs(1), ease: 'linear', target: 'left' }), stage({ id: id(), kind: 'enabled', on: false }), stage({ id: id(), kind: 'wait', seconds: 1 })])], {
        children: [node('left', box)],
      }),
    ])
    expectVec(doc.posesAt(1000, { sequences: true })[1]!.position, vec3(-2, 0, 0))
    expect(doc.posesAt(1500, { sequences: true }).map((p) => p.shown), 'the child goes with its root').toEqual([false, false])
  })

  it('carries a parent’s scaling down to its children, as the game does', () => {
    const doc = docOf([
      node('p', [seq([stage({ id: id(), kind: 'scale', to: vec3(2, 2, 2), timing: secs(1), ease: 'linear' }), stage({ id: id(), kind: 'wait', seconds: 1 })])], {
        children: [node('kid', box, { transform: { position: vec3(1, 0, 0) } })],
      }),
    ])
    expectVec(doc.posesAt(1000, { sequences: true })[0]!.scale, vec3(2, 2, 2))
    expectVec(doc.posesAt(1000, { sequences: true })[1]!.scale, vec3(1, 1, 1)) // its own scale; the group above carries the rest
  })

  it('knows which nodes a sequence can fade, and which it moves', () => {
    const doc = docOf([
      node('p', [...box, seq([stage({ id: id(), kind: 'fade', to: 0, timing: secs(1), ease: 'linear', target: 'kid' })])], { children: [node('kid', box)] }),
      node('still', box),
    ])
    expect([0, 1, 2].map((i) => doc.fadesAt(i))).toEqual([false, true, false])
    expect([0, 1, 2].map((i) => doc.movesAt(i))).toEqual([false, true, false])
  })
})

/** A drag mid-preview must write the authored transform, never the animation (ADR 0050, ADR 0126). */
describe('taking the preview back out', () => {
  it('recovers the authored transform from a group that shows a sequence’s turn and scale', () => {
    const authored = { position: vec3(1, 2, 3), rotation: vec3(0.3, -0.4, 0.2), scale: vec3(2, 1, 0.5) }
    const off = { position: vec3(0, 4, 0), turn: axisAngleToQuat(vec3(1, 1, 0), 1.1), scale: vec3(3, 1, 2) }
    const shown = mulQuat(eulerToQuat(authored.rotation), off.turn)
    const group = {
      position: vec3(authored.position.x + off.position.x, authored.position.y + off.position.y, authored.position.z + off.position.z),
      quaternion: shown,
      scale: vec3(authored.scale.x * off.scale.x, authored.scale.y * off.scale.y, authored.scale.z * off.scale.z),
    }
    const back = unpreviewed(group, off)
    expectVec(back.position, authored.position)
    expectVec(back.rotation, authored.rotation)
    expectVec(back.scale, authored.scale)
  })

  it('leaves a group with no preview on it exactly as it is', () => {
    const back = unpreviewed({ position: vec3(1, 1, 1), quaternion: quat(), scale: vec3(1, 1, 1) }, { position: ZERO, turn: quat(), scale: vec3(1, 1, 1) })
    expectVec(back.position, vec3(1, 1, 1))
    expectVec(back.rotation, ZERO)
  })
})

describe('the Motion button', () => {
  const setup = () => {
    const doc = docOf([node('p', [...box, seq([stage({ id: id(), kind: 'move', to: vec3(0, 4, 0), timing: secs(2), ease: 'linear' }, { id: id(), kind: 'scale', to: vec3(2, 2, 2), timing: secs(2), ease: 'linear' }), stage({ id: id(), kind: 'wait', seconds: 1 })])])])
    const group = new THREE.Group()
    const preview = createMotionPreview({ doc: () => doc, groupAt: (i) => (i === 0 ? group : undefined), inspectorSync: () => {}, renderStatus: () => {}, toolbarRender: () => {} })
    return { group, preview }
  }

  it('poses sequences while it runs, and puts everything back as it was set up when stopped', () => {
    const { group, preview } = setup()
    preview.setPlaying(true)
    preview.advance(1000)
    expect(group.position.y).toBeCloseTo(2, 9)
    expect(group.scale.x).toBeCloseTo(1.5, 9)
    expect(preview.offsetAt(0, 1000).scale.x).toBeCloseTo(1.5, 9)
    preview.setPlaying(false)
    expect(group.position.y).toBe(0)
    expect(group.scale.x).toBe(1)
    expect(group.visible).toBe(true)
  })

  it('reads the authored transform inside `withAuthoredPoses`, and returns to the preview after', () => {
    const { group, preview } = setup()
    preview.setPlaying(true)
    preview.advance(1000)
    expect(preview.withAuthoredPoses(() => group.scale.x)).toBe(1)
    expect(group.scale.x).toBeCloseTo(1.5, 9)
  })
})
