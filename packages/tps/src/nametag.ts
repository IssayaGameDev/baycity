import { CHAR_HALF_HEIGHT, CHAR_RADIUS } from '@mp/humanoid'
import { THREE, worldLabel } from '@mp/render-three'

/**
 * A billboard nametag: a canvas-texture `Sprite` that always faces the camera. Lives on the
 * overlay layer so post-FX never touches it (a lit sprite got a dark AO ghost). Rebuild only
 * when the text changes — the caller owns the lifecycle.
 */
export const makeNameLabel = (text: string): THREE.Sprite => {
  // The drawing is `@mp/render-three`'s (ADR 0082); what is the humanoid's is where it hangs: over the head.
  const sprite = worldLabel([{ text, size: 32 }], { heightM: 0.5 })
  sprite.position.set(0, CHAR_HALF_HEIGHT + CHAR_RADIUS + 0.5, 0)
  return sprite
}
