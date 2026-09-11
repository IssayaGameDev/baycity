import { defineComponent } from '@mp/components'

/**
 * The treadmill: stand on it and earn as if you were running (ADR 0080).
 *
 * The game being cloned lets you park on a treadmill and gain passively. Kodjo's reading of how: **the treadmill
 * steps for you**, at the same cadence as holding a direction on the ground, exactly as you would over
 * real keys. The **steps a second** are the game's own rule (ADR 0081, `steps.ts`: a fixed cadence), and **what
 * each step pays** is a key's Experience times this treadmill's multiplier. The multiplier is on the payout, not
 * the cadence — a ×9 treadmill does not step nine times faster, it pays nine per step.
 *
 * Headless: the component reports contact through the one effect that carries a node, every tick you stand on
 * it (`onContact` is a stay, not an enter), and the game's session reads the multiplier off the node. Only the
 * local character's contacts reach a component, so only you earn on it.
 */
export const Treadmill = defineComponent({
  type: 'Treadmill',
  label: 'Treadmill',
  params: {
    /** What the sign over it says. The real game's tiers are named: Chocolate, Gold, Diamond, Candy, Admin. */
    name: { kind: 'string', default: 'Treadmill', label: 'name' },
    /** Chocolate is 1. The real game's paid tiers are 3, 9, 25 and 100. */
    multiplier: { kind: 'number', default: 1, min: 1, step: 1, label: 'multiplier' },
  },
  singleton: true,
  onContact: (_self, ctx, hit) => ctx.effects.progress(hit.node),
})

/** What standing on a treadmill for one tick is: the tier of the one you are on. */
export interface TreadmillTick {
  multiplier: number
}

/** What one treadmill step pays: a key's Experience, times the tier. Chocolate pays what a key does. */
export const treadmillStepValue = (perKey: number, on: TreadmillTick): number => perKey * on.multiplier
