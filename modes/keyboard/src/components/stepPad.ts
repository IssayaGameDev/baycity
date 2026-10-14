import { defineComponent } from '@mp/components'

/**
 * A pad that sets what a step pays (ADR 0082). The game being cloned's row of numbered buttons at spawn:
 * `+1/step` for free, `+2/step` at 3 Wins, up to `+500/step` at 50K Wins.
 *
 * Step on one you qualify for and it becomes your **per-step** value — every ground step and every treadmill
 * step pays it from then on (times the treadmill's multiplier). Kodjo's calls: stepping on a lower pad you
 * qualify for switches you down; with no pad ever touched you are at the curve's `perKey` (1); on a pad you do
 * not qualify for, nothing happens.
 *
 * Headless, like the other pads: contact every tick through `effects.progress(node)`, the session reads the
 * two numbers off the node, the game decides against its Wins.
 */
export const StepPad = defineComponent({
  type: 'StepPad',
  label: 'Step pad',
  params: {
    // Set by the level's `World` from the game's pad table, by this pad's place in its list (ADR 0222): hidden here.
    perStep: { kind: 'number', default: 1, min: 1, step: 1, label: 'per step', hidden: true },
    requiresWins: { kind: 'number', default: 0, min: 0, step: 1, label: 'requires wins', hidden: true },
    /** Worn while this pad's value is the one you are on. Empty leaves the pad's own material. */
    activeMaterial: { kind: 'asset', of: 'material', default: '', label: 'active material' },
    /** Worn otherwise. Empty leaves the pad's own material. */
    idleMaterial: { kind: 'asset', of: 'material', default: '', label: 'idle material' },
  },
  singleton: true,
  onContact: (_self, ctx, hit) => ctx.effects.progress(hit.node),
})

export interface StepPadOffer {
  perStep: number
  requiresWins: number
}

/** Whether a player with this many Wins may take the pad. Pure, and the whole gate. */
export const qualifies = (wins: number, pad: StepPadOffer): boolean => wins >= pad.requiresWins
