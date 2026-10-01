import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_REGISTRY } from '@mp/components'

import { levelNameFor, loadLevel, type ReadJson } from './levels'

/**
 * The level a page plays, fetched with only what it uses (ADR 0169): the index picks the name, the list names the
 * files, and a level or a list that will not load is an error while a prefab or material that will not is a
 * greyboxed piece.
 */

/** Engine plus the whole shared library: validation must pass for any fixture, whichever game it names. */
const ANY = DEFAULT_REGISTRY
const BASE = 'https://game.test/play/keyboard/'

const PAD = 'aaaaaaaaaaaaaaaa'
const RED = 'bbbbbbbbbbbbbbbb'
const BRICK = 'cccccccccccccccc'
const STYLE = 'dddddddddddddddd'

const level = (id: string, extra: Record<string, unknown> = {}): unknown => ({ id, config: { mode: { name: 'keyboard' } }, nodes: [], ...extra })

/** What the servers would answer, by absolute URL. */
const files = (): Record<string, unknown> => ({
  [`${BASE}content/keyboard/levels.json`]: { levels: ['default', 'bare'], default: 'default' },
  [`${BASE}content/keyboard/levels/default.needs.json`]: {
    level: 'content/keyboard/levels/default.level.json',
    assets: [
      { id: BRICK, kind: 'texture', path: 'assets/textures/brick.png', url: 'assets/brick-1a2b.png' },
      { id: RED, kind: 'material', path: 'assets/materials/red.mat.json', url: 'content/assets/materials/red.mat.json' },
      { id: PAD, kind: 'prefab', path: 'keyboard/assets/prefabs/pad.prefab.json', url: 'content/keyboard/assets/prefabs/pad.prefab.json' },
      { id: STYLE, kind: 'data', path: 'keyboard/assets/red.data.json', url: 'content/keyboard/assets/red.data.json' },
    ],
  },
  [`${BASE}content/keyboard/levels/default.level.json`]: level('default'),
  [`${BASE}content/assets/materials/red.mat.json`]: { shader: 'standard', params: {} },
  [`${BASE}content/keyboard/assets/prefabs/pad.prefab.json`]: { id: 'root', components: [] },
  [`${BASE}content/keyboard/assets/red.data.json`]: { type: 'KeyboardStyle', fields: { placeholder: '#ff0000' } },
  [`${BASE}content/keyboard/levels/bare.needs.json`]: { level: 'content/keyboard/levels/bare.level.json', assets: [] },
  [`${BASE}content/keyboard/levels/bare.level.json`]: level('bare'),
})

/** Reads from `table`, recording every URL asked for; a URL it lacks is a failed fetch. */
const reader = (table: Record<string, unknown>): { read: ReadJson; asked: string[] } => {
  const asked: string[] = []
  const read: ReadJson = async (url) => {
    asked.push(url)
    if (!(url in table)) throw new Error(`${url}: 404`)
    return table[url]
  }
  return { read, asked }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('which level', () => {
  const index = { levels: ['default', 'bare'], default: 'default' }

  it('is the one asked for when the game has it, else the default', () => {
    expect(levelNameFor('keyboard', index, 'bare')).toBe('bare')
    expect(levelNameFor('keyboard', index, null)).toBe('default')
  })

  it('falls back to the default for a name the game does not have, and says so', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(levelNameFor('keyboard', index, 'typo')).toBe('default')
    expect(error).toHaveBeenCalledWith(expect.stringContaining('no keyboard level "typo"'))
  })

  it('is an error for a game with no levels at all', () => {
    expect(() => levelNameFor('keyboard', { levels: [], default: 'default' }, null)).toThrow(/no keyboard levels/)
  })
})

describe('loading a level', () => {
  it('fetches the index, the list, the level and the prefab and material on the list — and no texture yet', async () => {
    const { read, asked } = reader(files())
    const played = await loadLevel('keyboard', null, ANY, BASE, read)
    expect(played.name).toBe('default')
    expect(played.level.id).toBe('default')
    expect(asked.sort()).toEqual(
      [
        `${BASE}content/keyboard/levels.json`,
        `${BASE}content/keyboard/levels/default.needs.json`,
        `${BASE}content/keyboard/levels/default.level.json`,
        `${BASE}content/assets/materials/red.mat.json`,
        `${BASE}content/keyboard/assets/prefabs/pad.prefab.json`,
        `${BASE}content/keyboard/assets/red.data.json`,
      ].sort(),
    )
  })

  it('hands over the list as the asset database, its files at their absolute addresses, its prefabs and materials resolved', async () => {
    const played = await loadLevel('keyboard', null, ANY, BASE, reader(files()).read)
    expect(played.db.entries.map((e) => e.id).sort()).toEqual([BRICK, PAD, RED, STYLE].sort())
    expect(played.urlOf('assets/textures/brick.png')).toBe(`${BASE}assets/brick-1a2b.png`)
    expect(played.materialOf(RED)?.shader).toBe('standard')
    expect(played.prefabs.root(PAD)?.id).toBe('root')
    expect(played.prefabs.root(RED), 'a material is no prefab').toBeUndefined()
    // A data asset (ADR 0181), as its file holds it, for the game to read against its type.
    expect(played.dataOf(STYLE)).toEqual({ type: 'KeyboardStyle', fields: { placeholder: '#ff0000' } })
  })

  it('downloads nothing another level uses', async () => {
    const { read, asked } = reader(files())
    await loadLevel('keyboard', 'bare', ANY, BASE, read)
    expect(asked.some((u) => u.includes('red.mat.json') || u.includes('pad.prefab.json'))).toBe(false)
  })

  it('plays on with a material that will not load: an unresolved reference, which greyboxes', async () => {
    const table = files()
    delete table[`${BASE}content/assets/materials/red.mat.json`]
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const played = await loadLevel('keyboard', null, ANY, BASE, reader(table).read)
    expect(played.materialOf(RED)).toBeUndefined()
    expect(played.prefabs.root(PAD)?.id).toBe('root')
  })

  it('is an error when the level itself will not load, will not validate, or is another game’s', async () => {
    const gone = files()
    delete gone[`${BASE}content/keyboard/levels/default.level.json`]
    await expect(loadLevel('keyboard', null, ANY, BASE, reader(gone).read)).rejects.toThrow(/404/)

    const broken = files()
    broken[`${BASE}content/keyboard/levels/default.level.json`] = { id: 'default', config: {}, nodes: 'nope' }
    await expect(loadLevel('keyboard', null, ANY, BASE, reader(broken).read)).rejects.toThrow(/nodes/)

    const theirs = files()
    theirs[`${BASE}content/keyboard/levels/default.level.json`] = { ...(level('default') as object), config: { mode: { name: 'parkour' } } }
    await expect(loadLevel('keyboard', null, ANY, BASE, reader(theirs).read)).rejects.toThrow(/belongs to another game/)
  })

  it('is an error when the index or the list is not what it should be', async () => {
    const noIndex = files()
    noIndex[`${BASE}content/keyboard/levels.json`] = '<html>'
    await expect(loadLevel('keyboard', null, ANY, BASE, reader(noIndex).read)).rejects.toThrow(/not a level index/)

    const noList = files()
    noList[`${BASE}content/keyboard/levels/default.needs.json`] = { assets: [] }
    await expect(loadLevel('keyboard', null, ANY, BASE, reader(noList).read)).rejects.toThrow(/not a level's list/)
  })

  it('resolves every address against the page’s own, whatever base it is served under', async () => {
    const table = Object.fromEntries(Object.entries(files()).map(([k, v]) => [k.replace(BASE, 'https://portal.test/g/1/'), v]))
    const played = await loadLevel('keyboard', null, ANY, 'https://portal.test/g/1/', reader(table).read)
    expect(played.urlOf('assets/textures/brick.png')).toBe('https://portal.test/g/1/assets/brick-1a2b.png')
  })
})
