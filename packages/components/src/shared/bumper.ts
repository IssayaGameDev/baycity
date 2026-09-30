import { defineComponent } from '../define'

/**
 * Launches whatever lands on it.
 *
 * `power` is an upward speed in m/s, replacing the character's vertical velocity. Apex is
 * `power² / (2·gravity)`; at the tuned gravity of 55 a jump leaves the ground at `√(2·55·3) ≈ 18.2` m/s,
 * so **anything below 18 throws you lower than your own jump**. 26 gives about 6.1 m, roughly twice a
 * jump (ADR 0032).
 *
 * The default lives here rather than in the editor, which is where `DEFAULT_BUMPER_POWER` sat: a schema
 * value defaulted by the tool means hand-written JSON has no default at all.
 */
export const Bumper = defineComponent({
  type: 'Bumper',
  params: {
    power: { kind: 'number', default: 26, min: 1, max: 60, step: 1, label: 'launch (m/s)' },
  },
  singleton: true,
  /**
   * `self.params.power` is a `number` here with no cast and no lookup — the payoff of declaring parameters.
   *
   * The request goes through the character's `launch` field rather than onto `vy`, because leaving a surface
   * is five decisions in `stepCharacter` and not one (ADR 0032). `CharacterAccess.launch` keeps the strongest
   * request in a tick, so a stack of bumpers throws you as hard as the hardest one.
   */
  onContact: (self, ctx) => ctx.character.launch(self.params.power),
})
