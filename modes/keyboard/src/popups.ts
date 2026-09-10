import type { Vec3 } from '@mp/core'
import { Container, uiLabel } from '@mp/render-pixi'
import type { TpsClient } from '@mp/tps'

/**
 * A `+1` that floats off every key you strike (ADR 0072).
 *
 * The whole reward of an incremental game is watching the number move, and a counter that only ticks makes you
 * look away from your feet to see it. A label leaving the key you actually hit puts the reward where you are
 * already looking.
 *
 * **Screen space, captured at spawn.** The label is projected once, from the cap's top, and animates in overlay
 * pixels from there. Re-projecting every frame would make a swaying label jitter with the camera and cost a
 * projection per popup per frame, and nobody reads a number that is trying to stay glued to a moving key.
 */

export interface PopupFeel {
  /** How long one label lives (s). */
  life: number
  /** How far up it drifts over its life, in overlay pixels. */
  rise: number
  /** How far it swings either side, in overlay pixels. Small — this is a sway, not a wander. */
  sway: number
  /** Full sway cycles over the label's life. */
  sways: number
  /** How much larger it starts before settling. The pop that makes it feel struck rather than faded in. */
  pop: number
  /** Fraction of the life spent fully opaque before the fade starts. */
  hold: number
  /** Type size, in overlay pixels. */
  size: number
  /** Text colour. */
  color: number
}

export const DEFAULT_POPUP: PopupFeel = {
  life: 0.85,
  rise: 90,
  sway: 14,
  sways: 1.25,
  pop: 1.45,
  hold: 0.35,
  size: 26,
  color: 0xffe9a8,
}

/**
 * The most labels on screen at once.
 *
 * A cap-sized cap and a running player is a handful a second, so this is generous — and it is a **pool**, so
 * the ceiling costs nothing until it is reached. Past it the oldest is recycled, which is the right thing to
 * lose: a label already fading is the one nobody is reading.
 */
const POOL = 48

interface Popup {
  label: ReturnType<typeof uiLabel>
  /** Where it was born, in overlay pixels. */
  x: number
  y: number
  /** Its own sway offset, so two labels born together do not move as one. */
  phase: number
  /** Seconds lived, or `null` when the slot is free. */
  age: number | null
}

export interface Popups {
  /** Spawn one at each world point. Silently drops any behind the camera. */
  burst: (points: readonly Vec3[], text: string) => void
  /** Once per rendered frame. */
  update: (dt: number) => void
  dispose: () => void
}

export const createPopups = (client: TpsClient, feel: PopupFeel = DEFAULT_POPUP): Popups => {
  const root = new Container()
  client.ui.root.addChild(root)

  const pool: Popup[] = Array.from({ length: POOL }, () => {
    const label = uiLabel('', { size: feel.size, weight: '700', align: 'center', color: feel.color })
    label.anchor.set(0.5, 0.5)
    label.visible = false
    root.addChild(label)
    return { label, x: 0, y: 0, phase: 0, age: null }
  })

  /** Round-robin, so the slot taken when the pool is full is the one that has been alive longest. */
  let next = 0

  const take = (): Popup => {
    const free = pool.find((p) => p.age === null)
    if (free !== undefined) return free
    const oldest = pool[next]!
    next = (next + 1) % POOL
    return oldest
  }

  return {
    burst: (points, text) => {
      for (const point of points) {
        const at = client.toScreen(point)
        // Behind the lens: no sensible place to put it, and drawing it at the mirrored position would put a
        // label where nothing was struck.
        if (at === null) continue
        const p = take()
        p.label.text = text
        p.x = at.x
        p.y = at.y
        p.phase = Math.random() * Math.PI * 2
        p.age = 0
        p.label.visible = true
      }
    },

    update: (dt) => {
      for (const p of pool) {
        if (p.age === null) continue
        p.age += dt
        const t = p.age / feel.life
        if (t >= 1) {
          p.age = null
          p.label.visible = false
          continue
        }
        // Eased rise: quick off the key, slowing as it fades, which reads as being thrown rather than dragged.
        const eased = 1 - (1 - t) * (1 - t)
        p.label.position.set(p.x + Math.sin(p.phase + t * Math.PI * 2 * feel.sways) * feel.sway, p.y - eased * feel.rise)
        // Opaque for the first stretch, then out. Fading from the first frame makes the number hard to read at
        // exactly the moment it appears.
        p.label.alpha = t < feel.hold ? 1 : 1 - (t - feel.hold) / (1 - feel.hold)
        // Overshoot and settle inside the first tenth of the life.
        const grow = Math.min(1, t / 0.12)
        p.label.scale.set(feel.pop + (1 - feel.pop) * grow)
      }
    },

    dispose: () => {
      client.ui.root.removeChild(root)
      // Pixi's own recursive teardown: every label owns a text texture.
      root.destroy({ children: true })
    },
  }
}
