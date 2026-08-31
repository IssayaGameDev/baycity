import { describe, expect, it } from 'vitest'

import { actionsHeld } from './actions'

/**
 * The one part of the input path with no DOM in it (ADR 0061), and the part both hosts share — so a bug here
 * would be a game whose controls work in play and not in the editor, or the reverse.
 */

const keys = (...codes: string[]): ReadonlySet<string> => new Set(codes)

describe('actionsHeld', () => {
  it('is empty for a game that declared no actions', () => {
    expect([...actionsHeld(undefined, keys('ShiftLeft'))]).toEqual([])
    expect([...actionsHeld({}, keys('ShiftLeft'))]).toEqual([])
  })

  it('names the actions whose keys are down', () => {
    const bindings = { dash: ['ShiftLeft'], grapple: ['KeyE'] }
    expect([...actionsHeld(bindings, keys('ShiftLeft'))]).toEqual(['dash'])
    expect([...actionsHeld(bindings, keys('KeyE', 'ShiftLeft')).values()].sort()).toEqual(['dash', 'grapple'])
    expect([...actionsHeld(bindings, keys('KeyQ'))]).toEqual([])
  })

  /** What a binding list is for: either shift, either alt. */
  it('holds an action if any of its keys is down', () => {
    const bindings = { crouch: ['ShiftLeft', 'ShiftRight', 'KeyC'] }
    for (const code of ['ShiftLeft', 'ShiftRight', 'KeyC']) expect([...actionsHeld(bindings, keys(code))]).toEqual(['crouch'])
  })

  /** One key may drive two actions — nothing says a binding is exclusive. */
  it('lets one key hold several actions', () => {
    const held = actionsHeld({ dash: ['ShiftLeft'], sprint: ['ShiftLeft'] }, keys('ShiftLeft'))
    expect([...held].sort()).toEqual(['dash', 'sprint'])
  })

  it('never reports an action with no keys bound', () => {
    expect([...actionsHeld({ unbound: [] }, keys('ShiftLeft', 'KeyE'))]).toEqual([])
  })
})
