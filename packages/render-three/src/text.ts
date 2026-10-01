/// <reference path="./troika-three-text.d.ts" />
import * as THREE from 'three'
import { Text } from 'troika-three-text'

import { OVERLAY_LAYER } from './stage'

/**
 * Text in the world (ADR 0189): one way to draw it, for the `Text` component, a nametag and a sign alike.
 *
 * `troika-three-text`: each block of text is a mesh of glyph quads, laid out in a worker and drawn from one shared
 * signed-distance atlas, so it is sharp at any size and distance and costs one draw call. The default font is this
 * package's own file, Roboto (OFL, `fonts/OFL.txt`), so text never waits on another site; any other is an uploaded
 * font's URL (ADR 0190). The library reaches for a CDN only for a character its font has not got.
 *
 * **Bold is drawn, for every font alike** (ADR 0190, Kodjo's call): each letter's edge widened in its own colour —
 * an outline the colour of the text — so one file is every font, and bold is one look whatever the font.
 *
 * Two facings. **On the object**: the text lies in the node's own XY plane, read from its +Z (the blue axis
 * toward the reader), turning and scaling with it — Unity's TextMeshPro. **Facing the camera**: it turns to each
 * camera that draws it, about its own origin or a parent's — a nametag, Roblox's BillboardGui.
 */

const ROBOTO = new URL('./fonts/roboto-latin-400-normal.woff', import.meta.url).href

/** How far bold widens each letter's edge, as a fraction of the font size: measured to ink Roboto as its own Bold file does. */
export const BOLD_WIDEN = 0.017

export interface TextStyle {
  text: string
  /** A font file's URL — `.ttf`, `.otf` or `.woff` — or `null` for Roboto. */
  font: string | null
  /** The font size, in metres: the em, a little more than a capital's height. */
  size: number
  /** sRGB `#rrggbb`. */
  color: string
  /** How the lines line up with each other. The block is centred on the origin whichever it is. */
  align: 'left' | 'center' | 'right'
  /** Where lines wrap, in metres; 0 for never. */
  width: number
  weight: 'normal' | 'bold'
  facing: 'object' | 'camera'
  /** From behind: the text mirrored, as Unity draws it, or nothing. Facing the camera there is no behind. */
  back: 'mirrored' | 'hidden'
  /** `'world'`: hidden behind what is in front of it, like any object. `'over'`: drawn over everything, after post-FX. */
  depth: 'world' | 'over'
  /** A factor of the colour's opacity: a fade. */
  opacity: number
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  text: '',
  font: null,
  size: 0.5,
  color: '#ffffff',
  align: 'center',
  width: 0,
  weight: 'normal',
  facing: 'object',
  back: 'mirrored',
  depth: 'world',
  opacity: 1,
}

export interface WorldText {
  /** The mesh. Placed, parented and shown by the caller; never moved by anything here but its facing. */
  readonly object: THREE.Mesh
  /** The material its opacity lives on — for a fade list (the editor's preview). Owned here. */
  readonly material: THREE.Material
  set: (style: Partial<TextStyle>) => void
  /** Opacity alone, every frame if need be: no relayout, unlike `set`. */
  fade: (opacity: number) => void
  /** `fn` once the current text is laid out, with its block's `[minX, minY, maxX, maxY]` in metres. */
  laidOut: (fn: (bounds: readonly [number, number, number, number]) => void) => void
  dispose: () => void
}

/** Where a camera-facing object turns: about its own origin, or about another's — a label's lines about the label's. */
export interface FacingOptions {
  around?: THREE.Object3D
}

const camAt = new THREE.Vector3()
const camTurn = new THREE.Quaternion()
const camScale = new THREE.Vector3()
const ownAt = new THREE.Vector3()
const ownTurn = new THREE.Quaternion()
const ownScale = new THREE.Vector3()
const pivotTurn = new THREE.Quaternion()
const pivotScale = new THREE.Vector3()

/**
 * Turn `object` to face whichever camera draws it, just before it is drawn — in that camera's pass, so every
 * pass and every viewport sees it square on. `around`: the pivot it keeps its place about, its own position
 * taken as an offset in that pivot's frame turned with the camera.
 *
 * Written into `matrixWorld` at draw time, which three has already computed for the frame, and nowhere else:
 * the object's own transform is the caller's and stays as they set it.
 */
export const faceCamera = (object: THREE.Object3D, opts: FacingOptions = {}): void => {
  const own = object.onBeforeRender.bind(object)
  object.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
    camera.matrixWorld.decompose(camAt, camTurn, camScale)
    object.matrixWorld.decompose(ownAt, ownTurn, ownScale)
    const around = opts.around
    if (around !== undefined && around !== object) {
      around.matrixWorld.decompose(ownAt, pivotTurn, pivotScale)
      const offset = object.position.clone().multiply(pivotScale).applyQuaternion(camTurn)
      ownAt.add(offset)
    }
    object.matrixWorld.compose(ownAt, camTurn, ownScale)
    own(renderer, scene, camera, geometry, material, group)
  }
}

/** Put a mesh in front of everything, after post-FX (ADR 0082), or back in the world. */
const placeDepth = (mesh: THREE.Mesh, material: THREE.Material, depth: TextStyle['depth'], order: number): void => {
  if (depth === 'over') {
    mesh.layers.set(OVERLAY_LAYER)
    mesh.renderOrder = 999 + order
    material.depthTest = false
  } else {
    mesh.layers.set(0)
    mesh.renderOrder = order
    material.depthTest = true
  }
}

export const createText = (style: Partial<TextStyle> = {}, facing: FacingOptions = {}): WorldText => {
  let now: TextStyle = { ...DEFAULT_TEXT_STYLE, ...style }
  const text = new Text()
  /**
   * The base material, which troika derives its own from. Unlit and not tone-mapped: a sign's white is white.
   * Writing no depth: a glyph's quad is mostly empty margin, and writing it would hide what is behind the gaps.
   */
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, toneMapped: false })
  text.material = material
  text.anchorX = 'center'
  text.anchorY = 'middle'
  // Turned at draw time when it faces the camera; set once, and the facing read each time it draws.
  let turns = false
  const waiting: ((bounds: readonly [number, number, number, number]) => void)[] = []

  const apply = (): void => {
    text.text = now.text
    text.fontSize = Math.max(1e-4, now.size)
    text.font = now.font ?? ROBOTO
    text.color = now.color
    text.outlineWidth = now.weight === 'bold' ? now.size * BOLD_WIDEN : 0
    text.outlineColor = now.color
    text.textAlign = now.align
    text.maxWidth = now.width > 0 ? now.width : Infinity
    material.opacity = Math.max(0, Math.min(1, now.opacity))
    // From behind, Unity's mirrored text, or nothing. Facing the camera it is never seen from behind.
    material.side = now.back === 'hidden' && now.facing === 'object' ? THREE.FrontSide : THREE.DoubleSide
    placeDepth(text, material, now.depth, 1)
    if (now.facing === 'camera' && !turns) {
      turns = true
      faceCamera(text, facing)
    }
    text.sync(() => {
      const bounds = text.textRenderInfo?.blockBounds
      if (bounds === undefined) return
      for (const fn of waiting.splice(0)) fn(bounds)
    })
  }
  apply()

  return {
    object: text,
    material,
    fade: (opacity) => {
      now = { ...now, opacity }
      material.opacity = Math.max(0, Math.min(1, opacity))
    },
    set: (next) => {
      if (next.facing !== undefined && next.facing !== now.facing && turns) {
        // A facing once turned stays turned: undoing the draw-time hook is not worth it for a rare edit.
        // The editor rebuilds a node's meshes when its parameters change, so this is never hit there.
        console.warn('createText: a text that faced the camera cannot be put back flat; build a new one')
      }
      now = { ...now, ...next }
      apply()
    },
    laidOut: (fn) => {
      const bounds = text.textRenderInfo?.blockBounds
      // Laid out already and nothing pending: answer now. Otherwise when the current layout lands.
      if (bounds !== undefined && waiting.length === 0) fn(bounds)
      else waiting.push(fn)
    },
    dispose: () => {
      text.dispose()
      // Troika disposes the material it derived from this one along with it.
      material.dispose()
    },
  }
}
