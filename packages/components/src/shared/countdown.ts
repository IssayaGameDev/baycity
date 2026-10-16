import { COUNTDOWN, SEQUENCE } from '@mp/content'
import { defineComponent } from '../define'

/**
 * A sign that counts down to a sequence's stages (ADR 0228, Kodjo's design): on a node with a `Text`, it says how long
 * until the next of the stages listed — a platform's fade-in, then its fade-out — each row with its own words, `{t}`
 * the seconds, one decimal. Words without `{t}` are said as they are. Past the sequence's last pass, the Text's own.
 *
 * Loader-evaluated, as a `Sequence` is, with no hook: on the sequence's own clock, so the same on every screen a
 * shared one is, and counting in the editor's Motion preview too (`countdownText`, `@mp/content`).
 *
 * Shared: a game adopts it the first time one is added to its level (ADR 0077).
 */
export const Countdown = defineComponent({
  type: COUNTDOWN,
  menu: 'Animation',
  label: 'Countdown',
  params: {
    /** The sequence counted on: drag its card from the Inspector, or pick it. */
    sequence: { kind: 'componentRef', of: SEQUENCE, label: 'sequence' },
    rows: {
      kind: 'list',
      label: 'counts to',
      item: {
        stage: { kind: 'number', default: 1, min: 1, step: 1, label: 'stage' },
        text: { kind: 'string', default: 'in {t}', label: 'says ({t} the seconds)' },
      },
      default: [],
    },
  },
  singleton: true,
})
