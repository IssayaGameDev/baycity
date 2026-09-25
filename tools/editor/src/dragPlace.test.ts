// @vitest-environment happy-dom
import { vec3, type Vec3 } from '@mp/core'
import { THREE } from '@mp/render-three'
import { describe, expect, it } from 'vitest'

import { createDragPlace, type DragPlaceHost } from './dragPlace'

/**
 * Dragging a prefab or a model into the viewport (ADR 0164): a see-through copy follows the pointer on the surface,
 * a drop places it there, and one that cannot go says why instead.
 */

const at = (type: string, x = 10, y = 20): Event => Object.assign(new Event(type, { bubbles: true, cancelable: true }), { clientX: x, clientY: y })

const rig = (over: Partial<DragPlaceHost> = {}) => {
  const target = document.createElement('div')
  const scene = new THREE.Scene()
  const placed: { id: string; at: Vec3 }[] = []
  const readouts: (string | null)[] = []
  let disposed = 0
  const material = new THREE.MeshBasicMaterial()
  const host: DragPlaceHost = {
    scene,
    subject: () => {
      const g = new THREE.Group()
      g.add(new THREE.Mesh(new THREE.BoxGeometry(), material))
      g.userData.dispose = () => void disposed++
      return g
    },
    load: async () => {},
    refusal: () => null,
    surfaceUnder: (x, y) => vec3(x, 0, y),
    place: (id, p) => void placed.push({ id, at: p }),
    readout: (text) => void readouts.push(text),
    ...over,
  }
  const drag = createDragPlace(target, host)
  const copy = (): THREE.Object3D | undefined => scene.children[0]
  return { target, scene, drag, placed, readouts, copy, material, disposed: () => disposed }
}

describe('dragging an asset into the viewport', () => {
  it('holds a see-through copy under the pointer, on the surface, and places it where it is let go', () => {
    const { target, drag, placed, copy, material, disposed } = rig()
    drag.dragging('pad')
    expect(copy()?.visible, 'not until it is over the viewport').toBe(false)
    const over = at('dragover', 3, 4)
    target.dispatchEvent(over)
    expect(over.defaultPrevented, 'a drop is taken').toBe(true)
    expect(copy()?.visible).toBe(true)
    expect(copy()?.position.toArray()).toEqual([3, 0, 4])
    const mesh = copy()!.children[0] as THREE.Mesh
    const faint = mesh.material as THREE.Material
    expect(faint, 'its own material, the shared one untouched').not.toBe(material)
    expect([faint.transparent, faint.opacity, material.transparent]).toEqual([true, 0.45, false])
    target.dispatchEvent(at('drop', 5, 6))
    expect(placed).toEqual([{ id: 'pad', at: vec3(5, 0, 6) }])
    expect(copy(), 'gone once dropped').toBeUndefined()
    expect(disposed()).toBe(1)
  })

  it('hides the copy off the world and outside the viewport, and takes it away when the drag ends', () => {
    let world = true
    const { target, drag, copy, placed } = rig({ surfaceUnder: (x, y) => (world ? vec3(x, 0, y) : null) })
    drag.dragging('pad')
    target.dispatchEvent(at('dragover'))
    world = false
    const sky = at('dragover')
    target.dispatchEvent(sky)
    expect([sky.defaultPrevented, copy()?.visible]).toEqual([false, false])
    world = true
    target.dispatchEvent(at('dragover'))
    target.dispatchEvent(at('dragleave'))
    expect(copy()?.visible).toBe(false)
    drag.dragging(null)
    expect(copy()).toBeUndefined()
    expect(placed).toEqual([])
  })

  it('says why one cannot go, beside the pointer, and takes no drop', () => {
    const { target, drag, readouts, placed, copy } = rig({ refusal: () => 'uses Treadmill, which this game does not have' })
    drag.dragging('pad')
    const over = at('dragover')
    target.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(false)
    expect(copy()?.visible).toBe(false)
    expect(readouts.at(-1)).toBe('uses Treadmill, which this game does not have')
    target.dispatchEvent(at('drop'))
    expect(placed).toEqual([])
  })

  it('builds the copy once what it needs has loaded, if the drag is still on', async () => {
    let ready = false
    let loaded: () => void = () => {}
    const { drag, copy } = rig({
      subject: () => (ready ? new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())) : null),
      load: () =>
        new Promise<void>((r) => {
          loaded = () => {
            ready = true
            r()
          }
        }),
    })
    drag.dragging('crate')
    expect(copy()).toBeUndefined()
    loaded()
    await Promise.resolve()
    await Promise.resolve()
    expect(copy()).toBeDefined()
  })
})
