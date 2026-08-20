import { poseAt, type Keyframe } from '@mp/content'
import { vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { deleteKey, keyNear, keyRows, moveKey, nudgeKey, pathPoints, putKey, setEasing, setKeyPose, snapTime, sortedKeys, oneKeyAt } from './trackEdit'

const at = (t: number, y = 0): Keyframe => ({ t, position: vec3(0, y, 0) })
const times = (keys: readonly Keyframe[]): number[] => keys.map((k) => k.t)

describe('sortedKeys', () => {
  it('orders by time and leaves the input alone', () => {
    const input = [at(500), at(0), at(200)]
    expect(times(sortedKeys(input))).toEqual([0, 200, 500])
    expect(times(input), 'the caller\'s array is untouched').toEqual([500, 0, 200])
  })
})

describe('keyNear', () => {
  const keys = [at(0), at(500), at(1000)]

  it('finds the key under a click within tolerance', () => {
    expect(keyNear(keys, 480, 60)).toBe(1)
    expect(keyNear(keys, 1000, 60)).toBe(2)
  })

  it('misses when nothing is close enough', () => {
    expect(keyNear(keys, 300, 60)).toBe(-1)
  })

  it('indexes the sorted array, so a hit test matches what the strip drew', () => {
    expect(keyNear([at(1000), at(0), at(500)], 990, 60)).toBe(2)
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

  it('keeps the replaced key\'s easing, so re-posing does not relinearise the segment', () => {
    const keys = putKey([{ t: 0, position: vec3(0, 1, 0), easing: 'step' }], at(0, 5))
    expect(keys[0]!.easing).toBe('step')
    expect(keys[0]!.position!.y).toBe(5)
  })

  it('lets an explicit easing override the replaced one', () => {
    const keys = putKey([{ t: 0, position: vec3(0, 1, 0), easing: 'step' }], { t: 0, position: vec3(0, 5, 0), easing: 'linear' })
    expect(keys[0]!.easing).toBe('linear')
  })
})

describe('moveKey', () => {
  it('retimes a key and reports where it ended up', () => {
    const { keys, index } = moveKey([at(0), at(500), at(1000)], 1, 700)
    expect(times(keys)).toEqual([0, 700, 1000])
    expect(index).toBe(1)
  })

  // A drag is continuous, so it *will* cross a neighbour. The caller holds an index across the drag.
  it('follows the key when a drag carries it past a neighbour', () => {
    const { keys, index } = moveKey([at(0, 1), at(500, 2), at(1000, 3)], 1, 1400)
    expect(times(keys)).toEqual([0, 1000, 1400])
    expect(index, 'the dragged key is now last').toBe(2)
    expect(keys[2]!.position!.y, 'and it is still the key that was dragged').toBe(2)
  })

  it('clamps at zero rather than letting a track start before it begins', () => {
    const { keys } = moveKey([at(0), at(500)], 1, -300)
    expect(times(keys)).toEqual([0, 0])
  })

  it('is a no-op for an index that is not there', () => {
    const { keys } = moveKey([at(0)], 7, 100)
    expect(times(keys)).toEqual([0])
  })

  it('preserves the pose and easing it is moving', () => {
    const { keys, index } = moveKey([{ t: 0, position: vec3(1, 2, 3), easing: 'in' }], 0, 900)
    expect(keys[index]!.position).toEqual(vec3(1, 2, 3))
    expect(keys[index]!.easing).toBe('in')
  })
})

describe('deleteKey', () => {
  it('removes one key by sorted index', () => {
    expect(times(deleteKey([at(0), at(500), at(1000)], 1))).toEqual([0, 1000])
  })

  // A track that starts at 500ms holds that pose until then, which is authorable and worth allowing.
  it('allows deleting the first key', () => {
    expect(times(deleteKey([at(0), at(500)], 0))).toEqual([500])
  })

  it('ignores an index that is not there', () => {
    expect(times(deleteKey([at(0)], 4))).toEqual([0])
  })
})

describe('setEasing', () => {
  it('sets the curve leaving one key and leaves its neighbours alone', () => {
    const keys = setEasing([at(0), at(500), at(1000)], 1, 'step')
    expect(keys.map((k) => k.easing)).toEqual([undefined, 'step', undefined])
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

describe('oneKeyAt', () => {
  it('is a single held key, so no duration is invented', () => {
    const keys = oneKeyAt({ position: vec3(1, 2, 3), rotation: vec3(0, 0.5, 0) })
    expect(keys).toHaveLength(1)
    expect(keys[0]!.t).toBe(0)
  })

  it('holds the pose it was given, at any time', () => {
    const keys = oneKeyAt({ position: vec3(1, 2, 3), rotation: vec3(0, 0, 0) })
    const pose = poseAt({ kind: 'track', keys, loop: 'loop' }, { position: vec3(0, 0, 0) }, 12_345)
    expect(pose.position).toEqual(vec3(1, 2, 3))
  })
})

describe('keyRows', () => {
  it('places each key as a fraction of the duration', () => {
    const rows = keyRows([at(0), at(250), at(1000)])
    expect(rows.map((r) => r.at)).toEqual([0, 0.25, 1])
  })

  it('reports linear for a key with no easing written', () => {
    expect(keyRows([at(0)])[0]!.easing).toBe('linear')
  })

  it('marks keys that share a time, since that is an instant jump', () => {
    const rows = keyRows([at(0), at(500, 1), at(500, 2), at(1000)])
    expect(rows.map((r) => r.stacked)).toEqual([false, true, true, false])
  })

  it('says which channels a key carries, so the strip can show a pose key from a spin key', () => {
    const rows = keyRows([{ t: 0, position: vec3(0, 0, 0) }, { t: 100, rotation: vec3(0, 1, 0) }])
    expect(rows[0]).toMatchObject({ hasPosition: true, hasRotation: false })
    expect(rows[1]).toMatchObject({ hasPosition: false, hasRotation: true })
  })

  it('collapses to zero placement for a zero-length track rather than dividing by it', () => {
    const rows = keyRows([at(0), at(0)])
    expect(rows.map((r) => r.at)).toEqual([0, 0])
  })

  it('draws in time order even when the track is stored out of order', () => {
    expect(keyRows([at(1000), at(0)]).map((r) => r.t)).toEqual([0, 1000])
  })
})

describe('pathPoints', () => {
  it('is the positioned keys in time order', () => {
    const points = pathPoints([at(1000, 3), at(0, 1), at(500, 2)])
    expect(points.map((p) => p.position.y)).toEqual([1, 2, 3])
  })

  it('skips keys with no position, so a spin-only track draws no path', () => {
    expect(pathPoints([{ t: 0, rotation: vec3(0, 0, 0) }, { t: 500, rotation: vec3(0, 1, 0) }])).toEqual([])
  })
})
