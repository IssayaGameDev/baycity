import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { SelectionOutlinePass } from './selectionOutline'

/**
 * The selection outline (ADR 0145). The shaders need a GPU; what is pinned here is the part that could damage
 * the scene: each selected mesh wears an id material for the mask and must get its own back, whatever is drawn.
 */

/** A renderer that records what each draw saw, and nothing else. */
const recorder = () => {
  const draws: { root: THREE.Object3D; seen: Map<string, THREE.Material | THREE.Material[]>; lineShown: boolean[] }[] = []
  const clearColor = new THREE.Color(0x123456)
  const renderer = {
    autoClear: true,
    shadowMap: { enabled: true },
    getPixelRatio: () => 1,
    getClearColor: (target: THREE.Color) => target.copy(clearColor),
    getClearAlpha: () => 1,
    setClearColor: (c: THREE.ColorRepresentation) => void clearColor.set(c),
    setRenderTarget: () => {},
    clear: () => {},
    render: (root: THREE.Object3D) => {
      const seen = new Map<string, THREE.Material | THREE.Material[]>()
      const lineShown: boolean[] = []
      root.traverse((o) => {
        if (o instanceof THREE.Mesh && o.name !== '') seen.set(o.name, o.material)
        if (o instanceof THREE.Line) lineShown.push(o.visible)
      })
      draws.push({ root, seen, lineShown })
    },
  }
  return { renderer, draws, clearColor }
}

const mesh = (name: string): THREE.Mesh => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
  m.name = name
  return m
}

/** Mine: a platform with a child carrying a light gizmo's line; theirs: one crate; and a branch switched off. */
const scene = () => {
  const root = new THREE.Scene()
  const platform = new THREE.Group()
  const a = mesh('a')
  const child = new THREE.Group()
  const b = mesh('b')
  const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial())
  child.add(b, line)
  platform.add(a, child)
  const crate = new THREE.Group()
  const c = mesh('c')
  crate.add(c)
  const off = new THREE.Group()
  off.visible = false
  const inside = new THREE.Group()
  const d = mesh('d')
  inside.add(d)
  off.add(inside)
  root.add(platform, crate, off)
  return { platform, crate, inside, a, b, c, d, line }
}

describe('the selection outline', () => {
  it('draws each group in its own id, and gives every mesh and line back as it was', () => {
    const s = scene()
    const pass = new SelectionOutlinePass(new THREE.PerspectiveCamera())
    pass.setGroups([
      { roots: [s.platform], color: 0xffffff },
      { roots: [s.crate, s.inside], color: 0xff0000 },
    ])
    const originals = [s.a, s.b, s.c, s.d].map((m) => m.material)
    const { renderer, draws, clearColor } = recorder()
    const target = new THREE.WebGLRenderTarget(4, 4)
    pass.render(renderer as unknown as THREE.WebGLRenderer, target, target)

    const masks = draws.filter((d) => d.root === s.platform || d.root === s.crate || d.root === s.inside)
    expect(masks.map((d) => d.root), 'a branch switched off above it is not drawn').toEqual([s.platform, s.crate])
    const idOf = (m: THREE.Material | THREE.Material[] | undefined): number => Math.round((m as THREE.MeshBasicMaterial).color.r * 255)
    expect([idOf(masks[0]!.seen.get('a')), idOf(masks[0]!.seen.get('b')), idOf(masks[1]!.seen.get('c'))]).toEqual([1, 1, 2])
    expect(masks[0]!.lineShown, 'a line would write its own colour into the mask').toEqual([false])

    expect([s.a, s.b, s.c, s.d].map((m) => m.material)).toEqual(originals)
    expect(s.line.visible).toBe(true)
    expect([renderer.autoClear, renderer.shadowMap.enabled]).toEqual([true, true])
    expect(clearColor.getHex(), 'the clear colour it borrowed is put back').toBe(0x123456)
  })

  it('switches itself off with nothing to outline, so an empty selection costs nothing', () => {
    const pass = new SelectionOutlinePass(new THREE.PerspectiveCamera())
    pass.setGroups([{ roots: [], color: 0xffffff }])
    expect(pass.enabled).toBe(false)
    pass.setGroups([{ roots: [new THREE.Group()], color: 0xffffff }])
    expect(pass.enabled).toBe(true)
  })
})
