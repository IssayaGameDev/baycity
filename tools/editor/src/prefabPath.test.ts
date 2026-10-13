import { describe, expect, it } from 'vitest'

import { prefabFolder, prefabFolderFor, prefabTarget, sanitisePrefabName } from './prefabPath'

describe('where a prefab is saved', () => {
  it('writes into the folder the Project panel has open', () => {
    expect(prefabTarget('assets/prefabs/traps', 'Spike', [])).toEqual({ path: 'assets/prefabs/traps/Spike.prefab.json', name: 'Spike' })
  })

  it('falls back to prefabs/ at a library’s top, and the shared library’s across all folders (ADR 0161)', () => {
    expect(prefabFolder('assets')).toBe('assets/prefabs')
    expect(prefabFolder('keyboard/assets')).toBe('keyboard/assets/prefabs')
    expect(prefabFolder(null)).toBe('assets/prefabs')
    expect(prefabTarget(null, 'Spike', [])).toEqual({ path: 'assets/prefabs/Spike.prefab.json', name: 'Spike' })
  })

  /** Kodjo's call (ADR 0218): what a level saves goes where that level can place it, and where it may live. */
  it('goes to the level’s game’s own prefabs/ when the open folder cannot hold it', () => {
    const own = ['assets/materials/Red.mat.json', 'racing/assets/materials/Tarmac.mat.json']
    expect(prefabFolderFor('assets/materials', 'racing', own), 'Shared, using Racing’s').toBe('racing/assets/prefabs')
    expect(prefabFolderFor(null, 'racing', own), 'no folder open: Shared’s, so the same').toBe('racing/assets/prefabs')
    expect(prefabFolderFor('keyboard/assets/Prefabs', 'racing', ['assets/materials/Red.mat.json']), 'another game’s: the level could not place it').toBe('racing/assets/prefabs')
    expect(prefabFolderFor('assets/props', 'racing', ['assets/materials/Red.mat.json']), 'Shared, using only Shared’s: stays').toBe('assets/props')
    expect(prefabFolderFor('racing/assets/cars', 'racing', own), 'its own game’s: stays').toBe('racing/assets/cars')
  })

  /**
   * The refusal that matters. Writing over an existing prefab file keeps its `.meta` sidecar, so the asset id
   * would live on while its contents changed, and every level referencing that id would quietly become
   * something else.
   */
  it('refuses a name already in that folder rather than overwriting it', () => {
    expect(prefabTarget('assets/prefabs', 'Trampoline', ['assets/prefabs/Trampoline.prefab.json'])).toEqual({ error: 'a prefab called Trampoline is already in assets/prefabs/' })
    expect(prefabTarget('assets/prefabs/traps', 'Trampoline', ['assets/prefabs/Trampoline.prefab.json']), 'the same name in another folder is fine').toEqual({
      path: 'assets/prefabs/traps/Trampoline.prefab.json',
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
