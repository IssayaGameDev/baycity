import { poseAt, type Keyframe } from '@mp/content'
import { vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import {
  channelRow,
  channelSegments,
  copyKeys,
  deleteKeys,
  moveChannelKey,
  moveKeys,
  nudgeKey,
  pasteKeys,
  pathPoints,
  putChannel,
  putKey,
  restKeys,
  setEasingOn,
  setKeyPose,
  snapTime,
  sortedKeys,
} from './trackEdit'

const at = (t: number, y = 0): Keyframe => ({ t, position: vec3(0, y, 0) })
const spin = (t: number, y = 0): Keyframe => ({ t, rotation: vec3(0, y, 0) })
const both = (t: number, y = 0): Keyframe => ({ t, position: vec3(0, y, 0), rotation: vec3(0, y, 0) })
const times = (keys: readonly Keyframe[]): number[] => keys.map((k) => k.t)
const ORIGIN = vec3(0, 0, 0)

describe('sortedKeys', () => {
  it('orders by time and leaves the input alone', () => {
    const input = [at(500), at(0), at(200)]
    expect(times(sortedKeys(input))).toEqual([0, 200, 500])
    expect(times(input), "the caller's array is untouched").toEqual([500, 0, 200])
  })
})

describe('snapTime', () => {
  it('rounds onto the grid', () => {
    expect(snapTime(237, 100)).toBe(200)
    expect(snapTime(280, 100)).toBe(300)
  })

  it('snaps to nothing for a zero or negative grid', () => {
    expect(snapTime(237, 0)).toBe(237)
    expect(snapTime(237, -5)).toBe(237)
  })
})

describe('putKey', () => {
  it('inserts in time order wherever it lands', () => {
    expect(times(putKey([at(0), at(1000)], at(400)))).toEqual([0, 400, 1000])
  })

  // Pressing "+ key" twice at one playhead position must set the pose twice, not stack two keys — which
  // would make a zero-length segment where nobody asked for a jump.
  it('replaces a key at the same time rather than stacking one', () => {
    const keys = putKey([at(0, 1), at(1000)], at(0, 9))
    expect(times(keys)).toEqual([0, 1000])
    expect(keys[0]!.position!.y, 'the newer pose won').toBe(9)
  })

  it("keeps the replaced key's easing, so re-posing does not relinearise the segment", () => {
    const keys = putKey([{ t: 0, position: vec3(0, 1, 0), easing: 'step' }], at(0, 5))
    expect(keys[0]!.easing).toBe('step')
    expect(keys[0]!.position!.y).toBe(5)
  })

  it('lets an explicit easing override the replaced one', () => {
    const keys = putKey([{ t: 0, position: vec3(0, 1, 0), easing: 'step' }], { t: 0, position: vec3(0, 5, 0), easing: 'linear' })
    expect(keys[0]!.easing).toBe('linear')
  })
})

/** What Record mode writes: one channel, at the playhead. */
describe('putChannel', () => {
  it('writes one channel and leaves the other alone', () => {
    const { keys, index } = putChannel([spin(0, 1)], 0, 'position', vec3(0, 4, 0))
    expect(keys).toHaveLength(1)
    expect(keys[index]!.position).toEqual(vec3(0, 4, 0))
    expect(keys[index]!.rotation, 'the rotation that was there survives').toEqual(vec3(0, 1, 0))
  })

  /**
   * The reason Record mode does not use `putKey`. Nudging a platform sideways must not invent a rotation key,
   * because a one-key rotation channel is a *frozen* spin, not an absent one.
   */
  it('does not invent the channel it was not asked to write', () => {
    const { keys } = putChannel([], 500, 'position', vec3(1, 0, 0))
    expect(keys[0]!.position).toEqual(vec3(1, 0, 0))
    expect(keys[0]!.rotation).toBeUndefined()
  })

  it('merges into the key already at that time instead of stacking, so a drag cannot pile keys up', () => {
    let keys: readonly Keyframe[] = [at(0), at(1000)]
    for (const y of [1, 2, 3]) keys = putChannel(keys, 500, 'position', vec3(0, y, 0)).keys
    expect(times(keys)).toEqual([0, 500, 1000])
    expect(keys[1]!.position!.y, 'the last write won').toBe(3)
  })

  it('inherits the easing in force where it lands, so recording mid-segment does not relinearise it', () => {
    const keys = putChannel([{ t: 0, position: ORIGIN, easing: 'inOut' }, at(1000)], 400, 'position', vec3(0, 2, 0)).keys
    expect(keys[1]!.easing).toBe('inOut')
  })

  it('clamps at zero', () => {
    expect(putChannel([], -50, 'position', ORIGIN).keys[0]!.t).toBe(0)
  })
})

describe('moveChannelKey', () => {
  it('retimes a single-channel key and reports where it ended up', () => {
    const { keys, index } = moveChannelKey([at(0), at(500), at(1000)], 1, 'position', 700)
    expect(times(keys)).toEqual([0, 700, 1000])
    expect(index).toBe(1)
  })

  // A drag is continuous, so it *will* cross a neighbour. The caller holds an index across the drag.
  it('follows the key when a drag carries it past a neighbour', () => {
    const { keys, index } = moveChannelKey([at(0, 1), at(500, 2), at(1000, 3)], 1, 'position', 1400)
    expect(times(keys)).toEqual([0, 1000, 1400])
    expect(index, 'the dragged key is now last').toBe(2)
    expect(keys[2]!.position!.y, 'and it is still the key that was dragged').toBe(2)
  })

  /**
   * The edit the single-row panel could not express (ADR 0051). Two keys at different times each carrying one
   * channel is exactly what `poseAt` already samples, so this authors nothing new to the schema.
   */
  it('splits a key that carries both channels, moving only the one dragged', () => {
    const { keys, index } = moveChannelKey([both(0, 5), at(1000)], 0, 'position', 300)
    expect(times(keys)).toEqual([0, 300, 1000])
    expect(keys[0]!.rotation, 'rotation stayed at 0').toEqual(vec3(0, 5, 0))
    expect(keys[0]!.position, 'and left no position behind').toBeUndefined()
    expect(keys[index]!.position, 'position landed at 300').toEqual(vec3(0, 5, 0))
    expect(keys[index]!.rotation).toBeUndefined()
  })

  it('merges into a key already at the target time rather than stacking a second one there', () => {
    const { keys, index } = moveChannelKey([at(0, 2), spin(600, 3)], 0, 'position', 600)
    expect(times(keys)).toEqual([600])
    expect(keys[index]!.position).toEqual(vec3(0, 2, 0))
    expect(keys[index]!.rotation).toEqual(vec3(0, 3, 0))
  })

  // Clamped, and then merged by the rule above — dragging a key off the left onto the first one is a move,
  // not a way to accidentally author two keys at zero.
  it('clamps at zero, merging into the key already there', () => {
    const { keys } = moveChannelKey([at(0), at(500, 7)], 1, 'position', -300)
    expect(times(keys)).toEqual([0])
    expect(keys[0]!.position!.y, 'the dragged pose won').toBe(7)
  })

  it('is a no-op for a key that does not carry the channel, or an index that is not there', () => {
    expect(times(moveChannelKey([spin(0)], 0, 'position', 900).keys)).toEqual([0])
    expect(times(moveChannelKey([at(0)], 7, 'position', 900).keys)).toEqual([0])
  })

  it('preserves the pose and easing it is moving', () => {
    const { keys, index } = moveChannelKey([{ t: 0, position: vec3(1, 2, 3), easing: 'in' }], 0, 'position', 900)
    expect(keys[index]!.position).toEqual(vec3(1, 2, 3))
    expect(keys[index]!.easing).toBe('in')
  })
})

describe('moveKeys', () => {
  it('shifts every selected key by one delta and reports where they landed', () => {
    const { keys, indices } = moveKeys([at(0), at(500), at(1000)], [0, 1], 200)
    expect(times(keys)).toEqual([200, 700, 1000])
    expect(indices).toEqual([0, 1])
  })

  it('moves whole keys, both channels together — a bulk drag is about time, not one channel', () => {
    const { keys } = moveKeys([both(0, 4)], [0], 250)
    expect(keys[0]!.position).toEqual(vec3(0, 4, 0))
    expect(keys[0]!.rotation).toEqual(vec3(0, 4, 0))
    expect(keys[0]!.t).toBe(250)
  })

  /** Clamping per key would collapse the early ones onto each other and quietly destroy the shape. */
  it('clamps as a group, keeping the spacing when the earliest hits zero', () => {
    const { keys } = moveKeys([at(200), at(700), at(1200)], [0, 1, 2], -900)
    expect(times(keys)).toEqual([0, 500, 1000])
  })

  it('leaves unselected keys where they are', () => {
    const { keys } = moveKeys([at(0, 1), at(500, 2)], [1], 300)
    expect(times(keys)).toEqual([0, 800])
  })

  it('reports the surviving indices when a shift reorders the array', () => {
    const { keys, indices } = moveKeys([at(0, 1), at(500, 2)], [0], 900)
    expect(times(keys)).toEqual([500, 900])
    expect(indices).toEqual([1])
    expect(keys[1]!.position!.y, 'and it is the key that was moved').toBe(1)
  })

  it('is a no-op for an empty selection or a zero delta', () => {
    expect(times(moveKeys([at(0)], [], 500).keys)).toEqual([0])
    expect(times(moveKeys([at(0), at(500)], [1], 0).keys)).toEqual([0, 500])
  })
})

describe('deleteKeys', () => {
  it('removes several by sorted index', () => {
    expect(times(deleteKeys([at(0), at(500), at(1000)], [0, 2]))).toEqual([500])
  })

  // A track that starts at 500ms holds that pose until then, which is authorable and worth allowing.
  it('allows deleting the first key', () => {
    expect(times(deleteKeys([at(0), at(500)], [0]))).toEqual([500])
  })

  it('ignores indices that are not there', () => {
    expect(times(deleteKeys([at(0)], [4]))).toEqual([0])
    expect(times(deleteKeys([at(0)], []))).toEqual([0])
  })
})

describe('setEasingOn', () => {
  it('sets the curve leaving each named key and leaves its neighbours alone', () => {
    const keys = setEasingOn([at(0), at(500), at(1000)], [1], 'step')
    expect(keys.map((k) => k.easing)).toEqual([undefined, 'step', undefined])
  })

  it('sets several at once, which is what a multi-selection wants', () => {
    const keys = setEasingOn([at(0), at(500), at(1000)], [0, 2], 'inOut')
    expect(keys.map((k) => k.easing)).toEqual(['inOut', undefined, 'inOut'])
  })
})

describe('copyKeys and pasteKeys', () => {
  it('rebases a copy to zero, so a paste lands at the playhead rather than back where it came from', () => {
    expect(times(copyKeys([at(0), at(400), at(900)], [1, 2]))).toEqual([0, 500])
  })

  it('pastes at the playhead, keeping the spacing', () => {
    const { keys, indices } = pasteKeys([at(0)], copyKeys([at(400), at(900)], [0, 1]), 2000)
    expect(times(keys)).toEqual([0, 2000, 2500])
    expect(indices).toEqual([1, 2])
  })

  it('replaces whatever sits on the times it lands on, rather than stacking', () => {
    const { keys } = pasteKeys([at(0, 1), at(500, 2)], [at(0, 9)], 500)
    expect(times(keys)).toEqual([0, 500])
    expect(keys[1]!.position!.y, 'the pasted key won').toBe(9)
  })

  it('carries the poses and easings across', () => {
    const clip = copyKeys([{ t: 100, position: vec3(1, 2, 3), easing: 'out' }], [0])
    const { keys, indices } = pasteKeys([], clip, 700)
    expect(keys[indices[0]!]!.position).toEqual(vec3(1, 2, 3))
    expect(keys[indices[0]!]!.easing).toBe('out')
    expect(keys[indices[0]!]!.t).toBe(700)
  })

  it('copies nothing for an empty selection, and pasting nothing changes nothing', () => {
    expect(copyKeys([at(0)], [])).toEqual([])
    expect(times(pasteKeys([at(0)], [], 500).keys)).toEqual([0])
  })

  it('clamps a paste at zero', () => {
    expect(times(pasteKeys([], [at(0), at(500)], -200).keys)).toEqual([0, 500])
  })
})

describe('setKeyPose', () => {
  it('writes both channels', () => {
    const keys = setKeyPose([at(0)], 0, { position: vec3(1, 2, 3), rotation: vec3(0, 1, 0) })
    expect(keys[0]!.position).toEqual(vec3(1, 2, 3))
    expect(keys[0]!.rotation).toEqual(vec3(0, 1, 0))
  })

  it('leaves a channel the pose does not mention, so a translation-only track stays one', () => {
    const keys = setKeyPose([at(0, 5)], 0, { position: vec3(9, 9, 9) })
    expect(keys[0]!.position).toEqual(vec3(9, 9, 9))
    expect(keys[0]!.rotation, 'no rotation invented').toBeUndefined()
  })

  it('keeps the time and the easing', () => {
    const keys = setKeyPose([{ t: 750, position: vec3(0, 0, 0), easing: 'out' }], 0, { position: vec3(1, 1, 1) })
    expect(keys[0]!.t).toBe(750)
    expect(keys[0]!.easing).toBe('out')
  })
})

describe('nudgeKey', () => {
  it('adds a twin one millisecond later, which is how a step gets something to step from', () => {
    const keys = nudgeKey([at(0, 2), at(1000, 7)], 1)
    expect(times(keys)).toEqual([0, 1000, 1001])
    expect(keys[2]!.position!.y, 'holding the same pose').toBe(7)
  })
})

describe('restKeys', () => {
  it('is a single held key, so no duration is invented', () => {
    const keys = restKeys()
    expect(keys).toHaveLength(1)
    expect(keys[0]!.t).toBe(0)
  })

  /**
   * The reason it takes no pose (ADR 0050): a fresh track must leave the object exactly where it stands, for
   * any transform, at any time. Absolute keys had to be seeded with the current pose to manage that, and then
   * silently overrode every later transform edit.
   */
  it('leaves the object where it stands, whatever its transform', () => {
    const keys = restKeys()
    const b = { kind: 'track', keys, loop: 'loop' } as const
    expect(poseAt(b, { position: vec3(0, 0, 0) }, 12_345).position).toEqual(vec3(0, 0, 0))
    const somewhere = { position: vec3(1, 2, 3), rotation: vec3(0, 0.5, 0) }
    expect(poseAt(b, somewhere, 12_345).position).toEqual(vec3(1, 2, 3))
    expect(poseAt(b, somewhere, 12_345).rotation).toEqual(vec3(0, 0.5, 0))
  })
})

describe('channelRow', () => {
  const mixed = [at(0), both(500), spin(900), at(1400)]

  it('lists only the keys that touch the channel, in time order', () => {
    expect(channelRow(mixed, 'position').map((r) => r.t)).toEqual([0, 500, 1400])
    expect(channelRow(mixed, 'rotation').map((r) => r.t)).toEqual([500, 900])
  })

  it('indexes the sorted array, so a diamond and a mutation agree on which key was clicked', () => {
    expect(channelRow(mixed, 'rotation').map((r) => r.index)).toEqual([1, 2])
    expect(channelRow([at(1000), at(0)], 'position').map((r) => r.index)).toEqual([0, 1])
  })

  it('flags a key that carries the other channel too, since dragging it here splits it', () => {
    expect(channelRow(mixed, 'position').map((r) => r.shared)).toEqual([false, true, false])
  })

  // Only on the same channel: two keys at one time animating different channels is not a jump, it is one pose.
  it('flags a stacked key only when the clash is on this channel', () => {
    expect(channelRow([at(0), at(0)], 'position').map((r) => r.stacked)).toEqual([true, true])
    expect(channelRow([at(0), spin(0)], 'position').map((r) => r.stacked)).toEqual([false])
  })

  it('reports linear for a key that writes no easing', () => {
    expect(channelRow([at(0)], 'position')[0]!.easing).toBe('linear')
  })

  it('is empty for a channel the track does not animate', () => {
    expect(channelRow([at(0), at(500)], 'rotation')).toEqual([])
  })
})

describe('channelSegments', () => {
  /**
   * Between consecutive keys **of that channel**, which is what `poseAt` interpolates: it filters to the
   * channel and then walks. So a rotation key in the middle does not divide a position segment.
   */
  it('spans a key on the other channel rather than being divided by it', () => {
    const segs = channelSegments([at(0), spin(500), at(1000)], 'position')
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ fromMs: 0, toMs: 1000 })
  })

  it('carries the easing of the key it leaves, and that key’s index', () => {
    const segs = channelSegments([{ t: 0, position: ORIGIN, easing: 'step' }, at(1000)], 'position')
    expect(segs[0]).toMatchObject({ index: 0, easing: 'step' })
  })

  it('draws nothing for an instant jump, which has no stretch', () => {
    expect(channelSegments([at(0), at(0), at(1000)], 'position')).toHaveLength(1)
  })

  it('is empty for one key or none', () => {
    expect(channelSegments([at(0)], 'position')).toEqual([])
    expect(channelSegments([], 'position')).toEqual([])
  })
})

describe('pathPoints', () => {
  it('is the positioned keys in time order, with the index that addresses them', () => {
    const points = pathPoints([at(1000, 3), at(0, 1), at(500, 2)], ORIGIN)
    expect(points.map((p) => p.position.y)).toEqual([1, 2, 3])
    expect(points.map((p) => p.index)).toEqual([0, 1, 2])
  })

  it('skips keys with no position, so a spin-only track draws no path', () => {
    expect(pathPoints([spin(0), spin(500, 1)], ORIGIN)).toEqual([])
  })

  // The path is drawn where the object actually travels, and keys are offsets — so without the base it would
  // be drawn around the origin for every mover in the level.
  it('places the path on the authored position', () => {
    const points = pathPoints([at(0, 0), at(1000, 4)], vec3(10, 1, -6))
    expect(points.map((p) => p.position)).toEqual([vec3(10, 1, -6), vec3(10, 5, -6)])
  })
})
