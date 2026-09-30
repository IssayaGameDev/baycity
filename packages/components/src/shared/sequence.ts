import { SEQUENCE } from '@mp/content'
import { defineComponent } from '../define'

/**
 * An object's motion as stages of steps, a pure function of time (ADR 0137). Loader-evaluated, with no hook:
 * the editor only runs hooks while playing, and a sequence has to preview while editing. Being a pure function of
 * the synced clock, a late joiner needs no catch-up and a static subtree costs nothing.
 *
 * **Repeatable**: each loops on its own, and several on one node combine (moves add, off wins). Its settings
 * are ordinary parameters, so a placement overrides them like any other; its `stages` are patched step by
 * step (ADR 0139).
 *
 * Shared: a game adopts it the first time one is added to its level (ADR 0077).
 */
export const Sequence = defineComponent({
  type: SEQUENCE,
  menu: 'Animation',
  label: 'Sequence',
  params: {
    name: { kind: 'string', default: '', label: 'name' },
    /** The room's clock, the same on every screen, or this browser's own. */
    clock: { kind: 'enum', options: ['shared', 'local'], default: 'shared', label: 'clock' },
    /** The object's axes as placed, or the level's: for moves and turns both. */
    axes: { kind: 'enum', options: ['object', 'level'], default: 'object', label: 'axes' },
    loop: { kind: 'enum', options: ['restart', 'yoyo'], default: 'restart', label: 'loop' },
    /** Passes before it holds; 0 is forever. A yo-yo's out and back is two. */
    times: { kind: 'number', default: 0, min: 0, step: 1, label: 'times' },
    /** Where in its cycle it starts, as a fraction, for staggering a row. */
    offset: { kind: 'number', default: 0, min: 0, max: 1, step: 0.05, label: 'offset (cycles)' },
    stages: { kind: 'stages', default: [], label: 'stages' },
  },
})
