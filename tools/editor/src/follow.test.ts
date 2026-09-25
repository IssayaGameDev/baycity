import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CameraPresence, FollowPresence } from './collab'
import { approach, createFollow, FOLLOW_SEND_MS, posesDiffer, type CameraPose } from './follow'

/**
 * Following someone's view (ADR 0155): the follower's glide and when it ends, and the leader's stream — sent
 * only while someone follows, and only when the camera moved.
 */

const at = (x: number, ortho: number | null = null): CameraPose => ({ position: { x, y: 5, z: 10 }, target: { x, y: 0, z: 0 }, ortho })

const rig = (start: CameraPose = at(0)) => {
  let camera = start
  let playing = false
  const sent: (CameraPresence | FollowPresence)[] = []
  let changes = 0
  const follow = createFollow({
    pose: () => camera,
    setPose: (p) => void (camera = p),
    send: (d) => void sent.push(d),
    playing: () => playing,
    changed: () => void (changes += 1),
  })
  return {
    follow,
    sent,
    camera: () => camera,
    move: (p: CameraPose) => void (camera = p),
    play: (on: boolean) => void (playing = on),
    changes: () => changes,
  }
}

describe('poses', () => {
  it('tells a moved camera from rounding noise', () => {
    expect(posesDiffer(at(0), at(0.0001))).toBe(false)
    expect(posesDiffer(at(0), at(0.01))).toBe(true)
    expect(posesDiffer(at(0, 5), at(0, 5.5))).toBe(true)
    expect(posesDiffer(at(0), at(0, 5)), 'a change of projection').toBe(true)
  })
  it('glides part of the way, and lands a change of projection at once', () => {
    expect(approach(at(0), at(10), 0.5).position.x).toBe(5)
    expect(approach(at(0, 4), at(0, 8), 0.25).ortho).toBe(5)
    expect(approach(at(0), at(10, 6), 0.1)).toEqual(at(10, 6))
  })
})

describe('following', () => {
  it('says so, glides to what the leader sends, and says when it stops', () => {
    const r = rig()
    r.follow.start('ana')
    expect(r.sent).toEqual([{ kind: 'follow', leader: 'ana' }])
    r.follow.frame(1 / 60)
    expect(r.camera(), 'nothing to go to yet').toEqual(at(0))
    r.follow.onCamera('bob', at(-50))
    r.follow.onCamera('ana', at(10))
    for (let i = 0; i < 120; i += 1) r.follow.frame(1 / 60)
    expect(r.camera().position.x).toBeCloseTo(10, 3)
    r.follow.stop()
    expect(r.sent.at(-1)).toEqual({ kind: 'follow', leader: null })
    expect(r.follow.leader()).toBeNull()
    expect(r.changes()).toBe(2)
  })

  it('ends when the leader leaves the room, with nobody to tell', () => {
    const r = rig()
    r.follow.start('ana')
    r.follow.prune(new Set(['me', 'bob']))
    expect(r.follow.leader()).toBeNull()
    expect(r.sent).toHaveLength(1)
  })

  it('ends when a play session takes the camera', () => {
    const r = rig()
    r.follow.start('ana')
    r.follow.onCamera('ana', at(10))
    r.play(true)
    r.follow.frame(1 / 60)
    expect(r.follow.leader()).toBeNull()
    expect(r.camera()).toEqual(at(0))
  })

  it('says it again after a reconnect, and not when following nobody', () => {
    const r = rig()
    r.follow.announce()
    expect(r.sent).toEqual([])
    r.follow.start('ana')
    r.follow.announce()
    expect(r.sent).toEqual([{ kind: 'follow', leader: 'ana' }, { kind: 'follow', leader: 'ana' }])
  })
})

describe('leading', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const cameras = (sent: readonly (CameraPresence | FollowPresence)[]): number => sent.filter((s) => s.kind === 'camera').length

  it('sends nothing until someone follows, then at once, then only when the camera moved', () => {
    const r = rig()
    vi.advanceTimersByTime(FOLLOW_SEND_MS * 5)
    expect(r.sent).toEqual([])
    r.follow.onFollow('bob', 'me', 'me')
    expect(cameras(r.sent), 'the new follower gets the view straight away').toBe(1)
    vi.advanceTimersByTime(FOLLOW_SEND_MS * 5)
    expect(cameras(r.sent), 'a still camera').toBe(1)
    r.move(at(3))
    vi.advanceTimersByTime(FOLLOW_SEND_MS)
    expect(cameras(r.sent)).toBe(2)
    expect(r.sent.at(-1)).toEqual({ kind: 'camera', ...at(3) })
  })

  it('ignores a follow of someone else, and stops when the last follower goes', () => {
    const r = rig()
    r.follow.onFollow('bob', 'ana', 'me')
    expect(r.follow.followers()).toBe(0)
    r.follow.onFollow('bob', 'me', 'me')
    r.follow.onFollow('cy', 'me', 'me')
    r.follow.onFollow('bob', null, 'me')
    r.follow.prune(new Set(['me', 'bob']))
    expect(r.follow.followers()).toBe(0)
    const before = cameras(r.sent)
    r.move(at(9))
    vi.advanceTimersByTime(FOLLOW_SEND_MS * 5)
    expect(cameras(r.sent)).toBe(before)
  })

  it('sends nothing while playing', () => {
    const r = rig()
    r.play(true)
    r.follow.onFollow('bob', 'me', 'me')
    r.move(at(3))
    vi.advanceTimersByTime(FOLLOW_SEND_MS * 3)
    expect(cameras(r.sent)).toBe(0)
  })
})
