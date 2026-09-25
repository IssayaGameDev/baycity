import type { AssetOp } from '@mp/content'
import { describe, expect, it } from 'vitest'

import { createAssetSync, type Origin } from './assetSync'

/**
 * Live assets in the editor (ADR 0159): a local edit shows at once and goes one batch at a time, merged while it
 * waits; a collaborator's lands beneath it in the server's order; a number out of step fetches the live copy.
 */

const M = 'mmmmmmmmmmmmmmmm'
const colour = (v: string): AssetOp[] => [{ kind: 'set', path: ['params', 'color', 'value'], value: v }]
const rough = (v: number): AssetOp[] => [{ kind: 'set', path: ['params', 'roughness', 'value'], value: v }]
const mat = (c: string, r = 0.5) => ({ shader: 'standard', params: { color: { kind: 'color', value: c }, roughness: { kind: 'number', value: r } } })
const colourOf = (json: unknown): string => (json as ReturnType<typeof mat>).params.color.value
const roughOf = (json: unknown): number => (json as ReturnType<typeof mat>).params.roughness.value

const rig = (start = mat('#ff0000'), origin: Origin = { epoch: 7, seq: 0 }) => {
  let shown: unknown = start
  let libOrigin: Origin | undefined = origin
  const posts: { batchId: string; ops: AssetOp[]; answer: (why: string | null) => void }[] = []
  const shows: { json: unknown; remote: boolean }[] = []
  const refusals: string[] = []
  let live: { json: unknown; origin: Origin } | null = null
  const fetched: string[] = []
  const sync = createAssetSync({
    shown: () => shown,
    origin: () => libOrigin,
    show: (_id, json, remote) => {
      shown = json
      shows.push({ json, remote })
    },
    fetch: async (id) => {
      fetched.push(id)
      return live
    },
    post: (_id, batch) => new Promise((resolve) => posts.push({ ...batch, answer: resolve })),
    refused: (_id, why) => void refusals.push(why),
  })
  const echo = (seq: number, batchId: string, ops: AssetOp[], from = 'me', epoch = 7): void =>
    sync.onEvent({ assetId: M, epoch, seq, from, batchId, ops })
  return {
    sync,
    posts,
    shows,
    refusals,
    fetched,
    echo,
    shown: () => shown,
    setLive: (l: { json: unknown; origin: Origin }) => void (live = l),
    setLibrary: (json: unknown, o: Origin) => {
      shown = json
      libOrigin = o
    },
  }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('this tab’s edits', () => {
  it('shows at once, sends one batch, and merges what comes meanwhile into the next', async () => {
    const r = rig()
    r.sync.edit(M, colour('#000001'))
    expect(colourOf(r.shown())).toBe('#000001')
    expect(r.posts).toHaveLength(1)
    r.sync.edit(M, colour('#000002'))
    r.sync.edit(M, rough(0.1))
    r.sync.edit(M, colour('#000003'))
    expect(r.posts, 'one in flight').toHaveLength(1)
    expect(colourOf(r.shown())).toBe('#000003')
    r.echo(1, r.posts[0]!.batchId, r.posts[0]!.ops)
    expect(r.posts).toHaveLength(2)
    expect(r.posts[1]!.ops, 'the newest of each path').toEqual([...rough(0.1), ...colour('#000003')])
    expect(r.sync.busy(M)).toBe(true)
    r.echo(2, r.posts[1]!.batchId, r.posts[1]!.ops)
    expect(r.sync.busy(M)).toBe(false)
  })

  it('takes a refused edit back off the screen and says why', async () => {
    const r = rig()
    r.sync.edit(M, colour('#123456'))
    r.posts[0]!.answer('the connection is gone')
    await tick()
    expect(colourOf(r.shown())).toBe('#ff0000')
    expect(r.refusals).toEqual(['the connection is gone'])
  })
})

describe('someone else’s edits', () => {
  it('lands beneath this tab’s edits not confirmed yet, in the server’s order', () => {
    const r = rig()
    r.sync.edit(M, colour('#0000aa'))
    r.echo(1, 'theirs-1', rough(0.9), 'ana')
    expect(colourOf(r.shown()), 'mine still on top').toBe('#0000aa')
    expect(roughOf(r.shown()), 'theirs beneath').toBe(0.9)
    expect(r.shows.at(-1)!.remote).toBe(true)
    r.echo(2, 'theirs-2', colour('#00aa00'), 'ana')
    expect(colourOf(r.shown()), 'their colour landed before mine: mine wins on the server too').toBe('#0000aa')
    r.echo(3, r.posts[0]!.batchId, r.posts[0]!.ops)
    expect(colourOf(r.shown())).toBe('#0000aa')
    expect(r.sync.busy(M)).toBe(false)
  })

  it('ignores what the copy has already, and fetches the live copy for a gap or another epoch', async () => {
    const r = rig(mat('#ff0000'), { epoch: 7, seq: 4 })
    r.echo(3, 'old', colour('#abcdef'), 'ana')
    expect(colourOf(r.shown()), 'seq 3 is in a copy at 4').toBe('#ff0000')
    r.setLive({ json: mat('#111111'), origin: { epoch: 7, seq: 9 } })
    r.echo(9, 'gap', colour('#999999'), 'ana')
    await tick()
    expect(r.fetched).toEqual([M])
    expect(colourOf(r.shown())).toBe('#111111')
    r.setLive({ json: mat('#222222'), origin: { epoch: 8, seq: 1 } })
    r.echo(1, 'restart', colour('#333333'), 'ana', 8)
    await tick()
    expect(colourOf(r.shown()), 'a restarted server numbers again from 1').toBe('#222222')
  })
})

describe('a reload of the library', () => {
  it('takes a newer copy as confirmed and puts this tab’s pending edits back on top', () => {
    const r = rig()
    r.sync.edit(M, colour('#0000aa'))
    r.setLibrary(mat('#ff0000', 0.2), { epoch: 7, seq: 3 })
    r.sync.reloaded()
    expect(colourOf(r.shown())).toBe('#0000aa')
    expect(roughOf(r.shown())).toBe(0.2)
  })
})
