import { describe, expect, it } from 'vitest'
import { COLLIDER, LIGHT, RENDERER, type Level, type Node } from '@mp/content'
import { vec3 } from '@mp/core'
import { THREE } from '@mp/render-three'

import { levelDoc, type Doc } from './editorDoc'
import { createItemMeshes, type ItemMeshes } from './itemMeshes'

/**
 * A one-item rebuild draws what the full build would: the shadow cap (ADR 0047: the first four lights wanting a
 * shadow in document order get one) and a switched-off node (ADR 0099: nothing, nor under it).
 */

const lamp = (n: number): Node => ({
  id: `lamp${n}`,
  name: `lamp${n}`,
  transform: { position: vec3(n * 4, 3, 0) },
  components: [{ id: `lamp${n}-light`, type: LIGHT, params: { kind: 'point', castShadow: true } }],
})

const fiveLamps = (): Doc => levelDoc({ id: 'lv', config: {}, nodes: [0, 1, 2, 3, 4].map(lamp) } satisfies Level)

const meshesOver = (doc: Doc): ItemMeshes => {
  const meshes = createItemMeshes({
    doc: () => doc,
    loaded: () => null,
    runtime: () => null,
    mode: () => undefined,
    gameSettings: () => ({}),
    selected: () => null,
    hidden: () => false,
    afterBuild: () => {},
  })
  meshes.buildAll()
  return meshes
}

/** The indices whose drawn light casts a shadow. */
const casting = (meshes: ItemMeshes): number[] =>
  meshes.all().flatMap((g, i) => {
    let casts = false
    meshes.holderOf(g).traverse((o) => void (o instanceof THREE.Light && o.castShadow && (casts = true)))
    return casts ? [i] : []
  })

const setShadow = (doc: Doc, i: number, on: boolean): void => doc.setParams(i, `lamp${i}-light`, { castShadow: on })

describe('the editor shadow cap', () => {
  it('gives the first four lights wanting one a shadow', () => {
    expect(casting(meshesOver(fiveLamps()))).toEqual([0, 1, 2, 3])
  })

  it('keeps the same four however often one of them is rebuilt', () => {
    const meshes = meshesOver(fiveLamps())
    for (let n = 0; n < 6; n++) meshes.rebuildItem(1)
    expect(casting(meshes)).toEqual([0, 1, 2, 3])
  })

  it('hands a shadow given up to the next light in document order, as a full build would', () => {
    const doc = fiveLamps()
    const meshes = meshesOver(doc)
    setShadow(doc, 0, false)
    meshes.rebuildItem(0)
    expect(casting(meshes)).toEqual([1, 2, 3, 4])
    meshes.buildAll()
    expect(casting(meshes)).toEqual([1, 2, 3, 4])
  })

  it('takes a shadow taken back from the last light holding one', () => {
    const doc = fiveLamps()
    const meshes = meshesOver(doc)
    setShadow(doc, 0, false)
    meshes.rebuildItem(0)
    setShadow(doc, 0, true)
    meshes.rebuildSubtree(0)
    expect(casting(meshes)).toEqual([0, 1, 2, 3])
  })

  it('takes a switched-off light out of the dealing', () => {
    const doc = fiveLamps()
    const meshes = meshesOver(doc)
    doc.setNodeEnabled(0, false)
    meshes.rebuildSubtree(0)
    expect(casting(meshes)).toEqual([1, 2, 3, 4])
  })
})

/** A box with a box under it, both drawn. */
const box = (id: string, children: Node[] = []): Node => ({
  id,
  name: id,
  transform: { position: vec3(0, 0, 0) },
  components: [
    { id: `${id}-col`, type: COLLIDER, params: { shape: { kind: 'box', halfExtents: vec3(1, 0.5, 1) }, center: vec3(0, 0, 0) } },
    { id: `${id}-vis`, type: RENDERER, params: { material: '' } },
  ],
  children,
})

/** Whether each node's holder has anything drawn in it, in document order. */
const drawnNow = (meshes: ItemMeshes): boolean[] => meshes.all().map((g) => meshes.holderOf(g).children.length > 0)

describe('a switched-off node redrawn alone (ADR 0099)', () => {
  it('draws nothing, nor does anything under it, as after a full build', () => {
    const doc = levelDoc({ id: 'lv', config: {}, nodes: [box('parent', [box('kid')])] } satisfies Level)
    const meshes = meshesOver(doc)
    expect(drawnNow(meshes)).toEqual([true, true])
    doc.setNodeEnabled(0, false)
    meshes.rebuildSubtree(0)
    expect(drawnNow(meshes)).toEqual([false, false])
    meshes.rebuildItem(0) // a property edit on the switched-off node
    expect(drawnNow(meshes)).toEqual([false, false])
    doc.setNodeEnabled(0, true)
    meshes.rebuildSubtree(0)
    expect(drawnNow(meshes)).toEqual([true, true])
  })
})
