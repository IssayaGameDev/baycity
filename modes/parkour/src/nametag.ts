import { CHAR_HALF_HEIGHT, CHAR_RADIUS } from '@mp/character'
import { THREE } from '@mp/render-three'

/** Render layer for in-world UI drawn in a separate overlay pass, excluded from the
 * shadow / GTAO / tone-mapping pipeline. The mode renders this layer after post-FX. */
export const OVERLAY_LAYER = 1

/**
 * A billboard nametag: a canvas-texture `Sprite` that always faces the camera. Lives on the
 * overlay layer so post-FX never touches it (a lit sprite got a dark AO ghost). Rebuild only
 * when the text changes — the caller owns the lifecycle.
 */
export const makeNameLabel = (text: string): THREE.Sprite => {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.font = 'bold 32px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const w = Math.min(248, ctx.measureText(text).width + 24)
  ctx.fillStyle = 'rgba(11,16,32,0.6)'
  ctx.fillRect(128 - w / 2, 10, w, 44)
  ctx.fillStyle = '#e5e7eb'
  ctx.fillText(text, 128, 32)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace // canvas pixels are sRGB — decode them correctly
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false, // draw over the world
      depthWrite: false, // ...and stay out of the depth buffer GTAO reads
      toneMapped: false, // in-world UI, not a lit surface
    }),
  )
  sprite.scale.set(2, 0.5, 1)
  sprite.position.set(0, CHAR_HALF_HEIGHT + CHAR_RADIUS + 0.5, 0)
  sprite.renderOrder = 999
  sprite.layers.set(OVERLAY_LAYER)
  return sprite
}
