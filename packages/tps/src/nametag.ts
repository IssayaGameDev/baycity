import { CHAR_HALF_HEIGHT, CHAR_RADIUS } from '@mp/humanoid'
import { THREE, worldLabel } from '@mp/render-three'

/**
 * A nametag: a label that always faces the camera (ADR 0082, ADR 0189). Lives on the overlay layer so post-FX
 * never touches it (a lit one got a dark AO ghost). Rebuild only when the text changes, and free it with
 * `disposeWorldLabel` — the caller owns the lifecycle.
 */
export const makeNameLabel = (text: string): THREE.Group => {
  // The drawing is `@mp/render-three`'s; what is the humanoid's is where it hangs: over the head.
  const label = worldLabel([{ text, size: 32 }], { heightM: 0.5 })
  label.position.set(0, CHAR_HALF_HEIGHT + CHAR_RADIUS + 0.5, 0)
  return label
}
