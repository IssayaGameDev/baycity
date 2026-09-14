import { describe, expect, it } from 'vitest'

import { prefabFolder, prefabTarget, sanitisePrefabName } from './prefabPath'

describe('where a prefab is saved', () => {
  it('writes into the folder the Project panel has open', () => {
    expect(prefabTarget('prefabs/traps', 'Spike', [])).toEqual({ path: 'prefabs/traps/Spike.prefab.json', name: 'Spike' })
  })

  it('falls back to prefabs/ at the assets root and across all folders', () => {
    expect(prefabFolder('')).toBe('prefabs')
    expect(prefabFolder(null)).toBe('prefabs')
    expect(prefabTarget(null, 'Spike', [])).toEqual({ path: 'prefabs/Spike.prefab.json', name: 'Spike' })
  })

  /**
   * The refusal that matters. Writing over an existing prefab file keeps its `.meta` sidecar, so the asset id
   * would live on while its contents changed, and every level referencing that id would quietly become
   * something else.
   */
  it('refuses a name already in that folder rather than overwriting it', () => {
    expect(prefabTarget('prefabs', 'Trampoline', ['prefabs/Trampoline.prefab.json'])).toEqual({ error: 'a prefab called Trampoline is already in prefabs/' })
    expect(prefabTarget('prefabs/traps', 'Trampoline', ['prefabs/Trampoline.prefab.json']), 'the same name in another folder is fine').toEqual({
      path: 'prefabs/traps/Trampoline.prefab.json',
      name: 'Trampoline',
    })
  })

  it('refuses a name a file cannot carry, and an empty one', () => {
    expect(prefabTarget('prefabs', 'a/b', [])).toEqual({ error: '"a/b" is not a file name: letters, digits, - and _ only' })
    expect(prefabTarget('prefabs', '  ', [])).toEqual({ error: 'a prefab needs a name' })
    expect(prefabTarget('prefabs', 'my prefab', [])).toEqual({ error: '"my prefab" is not a file name: letters, digits, - and _ only' })
  })

  it('offers a usable name from whatever the object was called', () => {
    expect(sanitisePrefabName('step pad 3')).toBe('step-pad-3')
    expect(sanitisePrefabName('  Trampoline  ')).toBe('Trampoline')
    expect(sanitisePrefabName('a // b')).toBe('a-b')
    expect(sanitisePrefabName('!!!')).toBe('prefab')
    expect(sanitisePrefabName('')).toBe('prefab')
  })
})
