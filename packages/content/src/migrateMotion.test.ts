import { vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import {
  convertTrack,
  fingerprintMotion,
  firstMotionDifference,
  keysOfWith,
  migrateGameComponents,
  migrateTracksIn,
  newMotionReport,
  overriddenComponentIds,
  TRACK,
  type KeysOf,
} from './migrateMotion'
import { COLLIDER, type TypeInfo } from './nodes'
import { moveTrack, spinTrack, type Keyframe } from './retiredTrack'
import type { ComponentData, Level, Node } from './types'

const TYPES: TypeInfo = { get: (type) => (type === COLLIDER || type === 'Mover' ? {} : { singleton: true }) }
const INLINE: KeysOf = keysOfWith(() => undefined)

const track = (params: Record<string, unknown>, id = 't0'): ComponentData => ({ id, type: TRACK, params })

const node = (over: Partial<Node> = {}): Node => ({ id: 'n0', transform: { position: vec3(0, 0, 0) }, components: [], ...over })

describe('convertTrack', () => {
  it('reads a Move preset as a Mover, deriving the speed from the distance and the period', () => {
    // The shape every elevator in the content has: 3 m up over 4 s is 1.5 m/s.
    const done = convertTrack(track({ keys: moveTrack(vec3(0, 1, 0), 3, 4000), loop: 'loop', phaseMs: 0 }), moveTrack(vec3(0, 1, 0), 3, 4000))
    expect(done.kind).toBe('Mover')
    expect(done.kind === 'Mover' && done.params).toEqual({ move: vec3(0, 3, 0), speed: 1.5, smooth: true, offset: 0 })
  })

  it('keeps the exact authored distance, float dust and all', () => {
    const keys = moveTrack(vec3(0, 1, 0), 10.2, 1000)
    const done = convertTrack(track({ keys }), keys)
    expect(done.kind === 'Mover' && done.params.move).toEqual(vec3(0, 10.2, 0))
    expect(done.kind === 'Mover' && done.params.speed, '10.2 m over a 0.5 s leg').toBe(20.4)
  })

  it('reads a Spin preset as a Spinner on the signed axis', () => {
    const keys = spinTrack(vec3(0, 1, 0), 6000)
    const done = convertTrack(track({ keys }), keys)
    expect(done.kind).toBe('Spinner')
    expect(done.kind === 'Spinner' && done.params).toEqual({ axis: '+Y', speed: 60, offset: 0 })
  })

  it('reads a reversed spin as the opposite axis rather than a negative speed', () => {
    const keys = spinTrack(vec3(0, 0, -1), 4000)
    const done = convertTrack(track({ keys }), keys)
    expect(done.kind === 'Spinner' && done.params).toEqual({ axis: '-Z', speed: 90, offset: 0 })
  })

  it('turns phaseMs into a fraction of the cycle', () => {
    const keys = moveTrack(vec3(0, 1, 0), 3, 4000)
    expect(convertTrack(track({ keys, phaseMs: 2000 }), keys).kind === 'Mover').toBe(true)
    const done = convertTrack(track({ keys, phaseMs: 2000 }), keys)
    expect(done.kind === 'Mover' && done.params.offset).toBe(0.5)
    // A whole cycle of phase is no phase at all.
    expect((convertTrack(track({ keys, phaseMs: 4000 }), keys) as { params: Record<string, unknown> }).params.offset).toBe(0)
  })

  it('drops a track that never moved', () => {
    // The live one: three keys all at t=0, so `isAnimated` was already false.
    const dead: Keyframe[] = [
      { t: 0, position: vec3(0, 0, 0), easing: 'inOut' },
      { t: 0, position: vec3(0, 0, 0) },
      { t: 0, position: vec3(0, 10, 0), easing: 'inOut' },
    ]
    expect(convertTrack(track({ keys: dead }), dead)).toEqual({
      kind: 'drop',
      why: 'all 3 keys at one time, holding the rest pose, so it never moved',
    })
    expect(convertTrack(track({ keys: [] }), [])).toEqual({ kind: 'drop', why: 'no keys at all, so it never moved' })
  })

  it('refuses a still track that holds a real offset, because dropping it would move the node', () => {
    // One key in a channel is a constant offset (`poseAt`), so "no duration" does not mean "no effect". The
    // new model has no way to say displaced-and-still, so this is reported rather than guessed at.
    const held: Keyframe[] = [{ t: 0, position: vec3(0, 5, 0) }]
    const done = convertTrack(track({ keys: held }), held)
    expect(done.kind).toBe('refuse')
    expect(done.kind === 'refuse' && done.why).toContain('would move the node')
  })

  it('refuses a loop mode with no equivalent instead of guessing', () => {
    const keys = moveTrack(vec3(0, 1, 0), 3, 4000)
    expect(convertTrack(track({ keys, loop: 'pingPong' }), keys).kind).toBe('refuse')
    expect(convertTrack(track({ keys, loop: 'once' }), keys).kind).toBe('refuse')
  })

  it('refuses a hand-keyed track that merely looks like a preset', () => {
    // Three position keys, out and back — but the far key is off-centre in time, so it is not what the
    // preset emits and rebuilding it does not match. This is the case the gate exists for.
    const skewed: Keyframe[] = [
      { t: 0, position: vec3(0, 0, 0), easing: 'inOut' },
      { t: 3000, position: vec3(0, 3, 0), easing: 'inOut' },
      { t: 4000, position: vec3(0, 0, 0) },
    ]
    expect(convertTrack(track({ keys: skewed }), skewed).kind).toBe('refuse')

    // Right timing, wrong easing: a linear out-and-back is not the `Move` preset, and `smooth: true` would
    // have been a lie about its feel.
    const linear = moveTrack(vec3(0, 1, 0), 3, 4000).map((k) => ({ ...k, easing: 'linear' as const }))
    expect(convertTrack(track({ keys: linear }), linear).kind).toBe('refuse')

    // A path with a corner: four keys, nothing in the new model expresses it.
    const corner: Keyframe[] = [
      { t: 0, position: vec3(0, 0, 0) },
      { t: 1000, position: vec3(3, 0, 0) },
      { t: 2000, position: vec3(3, 3, 0) },
      { t: 3000, position: vec3(0, 0, 0) },
    ]
    expect(convertTrack(track({ keys: corner }), corner).kind).toBe('refuse')
  })

  it('reads a hand-typed 2π as a full turn, and says so', () => {
    // Both turntables in the content end at 6.2832 rather than 6.283185307…, because a key's value is
    // typeable (ADR 0051). The rate differs by 0.0002%.
    const typed: Keyframe[] = [
      { t: 0, rotation: vec3(0, 0, 0), easing: 'linear' },
      { t: 6000, rotation: vec3(0, 6.2832, 0) },
    ]
    const done = convertTrack(track({ keys: typed, loop: 'loop', phaseMs: 0 }), typed)
    expect(done.kind).toBe('Spinner')
    expect(done.kind === 'Spinner' && done.params).toEqual({ axis: '+Y', speed: 60, offset: 0 })
    expect(done.kind === 'Spinner' && done.detail, 'the rounding is reported, not hidden').toContain('read as 2π')
  })

  it('does not round a distance, because a Mover can say any distance exactly', () => {
    // The turn tolerance exists only to recognise 2π, which a person approximates. A distance needs no
    // tolerance at all: whatever the far key says is what the Mover travels, to the last decimal.
    const odd = moveTrack(vec3(0, 1, 0), 3.001, 4000)
    const done = convertTrack(track({ keys: odd }), odd)
    expect(done.kind === 'Mover' && done.params.move).toEqual(vec3(0, 3.001, 0))
  })

  it('refuses a near-turn that is not a turn at all', () => {
    // Half a turn is not within the tolerance, so it is a hand-keyed rotation and stays one.
    const half: Keyframe[] = [
      { t: 0, rotation: vec3(0, 0, 0), easing: 'linear' },
      { t: 6000, rotation: vec3(0, Math.PI, 0) },
    ]
    expect(convertTrack(track({ keys: half }), half).kind).toBe('refuse')
  })

  it('refuses a typed turn that is eased, since a Spinner has no easing', () => {
    const eased: Keyframe[] = [
      { t: 0, rotation: vec3(0, 0, 0), easing: 'inOut' },
      { t: 6000, rotation: vec3(0, 6.2832, 0) },
    ]
    expect(convertTrack(track({ keys: eased }), eased).kind).toBe('refuse')
  })

  it('refuses a spin about a slanted axis, which the new model cannot say', () => {
    const slanted: Keyframe[] = [
      { t: 0, rotation: vec3(0, 0, 0), easing: 'linear' },
      { t: 4000, rotation: vec3(Math.PI * 2, Math.PI * 2, 0) },
    ]
    expect(convertTrack(track({ keys: slanted }), slanted).kind).toBe('refuse')
  })

  it('reads a clip as if it were inline, since the loader does', () => {
    const keys = moveTrack(vec3(0, 1, 0), 3, 4000)
    const keysOf = keysOfWith((id) => (id === 'clip1' ? keys : undefined))
    const c = track({ clip: 'clip1', keys: [] })
    expect(convertTrack(c, keysOf(c)).kind).toBe('Mover')
  })
})

describe('migrateTracksIn', () => {
  it('replaces the component in place, keeping its id and its position among the others', () => {
    const root = node({
      components: [{ id: 'c0', type: COLLIDER, params: {} }, track({ keys: moveTrack(vec3(0, 1, 0), 3, 4000) }, 'c1'), { id: 'c2', type: 'Hazard', params: {} }],
    })
    const report = newMotionReport()
    expect(migrateTracksIn(root, 'x.json', INLINE, report)).toBe(true)
    expect(root.components.map((c) => [c.id, c.type])).toEqual([
      ['c0', COLLIDER],
      ['c1', 'Mover'],
      ['c2', 'Hazard'],
    ])
    expect(report.converted).toHaveLength(1)
    expect(report.converted[0]?.detail).toBe('3 m at 1.5 m/s')
  })

  it('keeps a disabled flag, so a switched-off mover stays switched off', () => {
    const root = node({ components: [{ ...track({ keys: moveTrack(vec3(0, 1, 0), 3, 4000) }, 'c0'), enabled: false }] })
    expect(migrateTracksIn(root, 'x.json', INLINE, newMotionReport())).toBe(true)
    expect(root.components[0]?.enabled).toBe(false)
  })

  it('descends into children', () => {
    const root = node({ children: [node({ id: 'n1', components: [track({ keys: spinTrack(vec3(0, 1, 0), 6000) })] })] })
    const report = newMotionReport()
    expect(migrateTracksIn(root, 'x.json', INLINE, report)).toBe(true)
    expect(root.children?.[0]?.components[0]?.type).toBe('Spinner')
    expect(report.converted[0]?.node).toBe('n1')
  })

  it('removes a dead track and reports it', () => {
    // Both keys at t=0, and the sampled one is the zero key — the live dead track's exact shape.
    const dead: Keyframe[] = [{ t: 0, position: vec3(0, 0, 0) }, { t: 0, position: vec3(0, 10, 0) }]
    const root = node({ components: [{ id: 'c0', type: COLLIDER, params: {} }, track({ keys: dead }, 'c1')] })
    const report = newMotionReport()
    expect(migrateTracksIn(root, 'x.json', INLINE, report)).toBe(true)
    expect(root.components.map((c) => c.id)).toEqual(['c0'])
    expect(report.dropped).toHaveLength(1)
  })

  it('refuses the whole file when one track cannot be read, leaving that track alone', () => {
    const skewed: Keyframe[] = [
      { t: 0, position: vec3(0, 0, 0) },
      { t: 900, position: vec3(0, 3, 0) },
      { t: 4000, position: vec3(0, 0, 0) },
    ]
    const root = node({ components: [track({ keys: moveTrack(vec3(0, 1, 0), 3, 4000) }, 'c0'), track({ keys: skewed }, 'c1')] })
    const report = newMotionReport()
    expect(migrateTracksIn(root, 'x.json', INLINE, report)).toBe(false)
    expect(report.refused).toHaveLength(1)
    expect(root.components.find((c) => c.id === 'c1')?.type, 'left exactly as it was').toBe(TRACK)
  })

  it('refuses a Track that an override names, rather than repointing it', () => {
    const root = node({
      id: 'p',
      components: [],
      overrides: { n0: { params: { c0: { phaseMs: 500 } } } },
      children: [node({ components: [track({ keys: moveTrack(vec3(0, 1, 0), 3, 4000) }, 'c0')] })],
    })
    const report = newMotionReport()
    expect(migrateTracksIn(root, 'x.json', INLINE, report, overriddenComponentIds(root))).toBe(false)
    expect(report.refused[0]?.why).toContain('an override')
  })
})

describe('overriddenComponentIds', () => {
  it('collects ids from params and enabled, at any depth', () => {
    const root = node({
      overrides: { a: { params: { c1: { x: 1 } } } },
      children: [node({ id: 'n1', overrides: { b: { enabled: { c2: false } } } })],
    })
    expect([...overriddenComponentIds(root)].sort()).toEqual(['c1', 'c2'])
  })
})

describe('migrateGameComponents', () => {
  it('swaps Track for both new components, keeping the rest and the sort', () => {
    expect(migrateGameComponents(['Bumper', 'Checkpoint', 'Goal', 'Hazard', 'Track'])).toEqual([
      'Bumper',
      'Checkpoint',
      'Goal',
      'Hazard',
      'Mover',
      'Spinner',
    ])
  })

  it('leaves a game that never opted into Track alone', () => {
    expect(migrateGameComponents(['Hazard'])).toBeNull()
    expect(migrateGameComponents([])).toBeNull()
  })

  it('does not duplicate one it already has', () => {
    expect(migrateGameComponents(['Mover', 'Track'])).toEqual(['Mover', 'Spinner'])
  })
})

describe('the motion gate', () => {
  const levelOf = (nodes: Node[]): Level => ({ id: 'lv', config: {}, nodes })

  it('says nothing about a level with no motion', () => {
    expect(fingerprintMotion(levelOf([node({ components: [{ id: 'c0', type: COLLIDER, params: {} }] })]), TYPES, INLINE)).toEqual([])
  })

  it('a converted Mover fingerprints identically to the Track it came from', () => {
    for (const [distance, periodMs] of [
      [3, 4000],
      [10.2, 1000],
      [10.1, 4000],
      [1.2, 4000],
      [10, 2000],
    ] as const) {
      const before = levelOf([node({ components: [track({ keys: moveTrack(vec3(0, 1, 0), distance, periodMs), loop: 'loop', phaseMs: 0 }, 'c0')] })])
      const after = structuredClone(before)
      expect(migrateTracksIn(after.nodes[0]!, 'x', INLINE, newMotionReport())).toBe(true)
      expect(firstMotionDifference(fingerprintMotion(before, TYPES, INLINE), fingerprintMotion(after, TYPES, INLINE))).toBeNull()
    }
  })

  it('a converted Spinner fingerprints identically, modulo the full turn at the wrap', () => {
    for (const periodMs of [6000, 4000, 1500]) {
      const before = levelOf([node({ components: [track({ keys: spinTrack(vec3(0, 1, 0), periodMs), loop: 'loop' }, 'c0')] })])
      const after = structuredClone(before)
      expect(migrateTracksIn(after.nodes[0]!, 'x', INLINE, newMotionReport())).toBe(true)
      expect(firstMotionDifference(fingerprintMotion(before, TYPES, INLINE), fingerprintMotion(after, TYPES, INLINE))).toBeNull()
    }
  })

  it('catches a wrong speed', () => {
    const before = levelOf([node({ components: [track({ keys: moveTrack(vec3(0, 1, 0), 3, 4000), loop: 'loop' }, 'c0')] })])
    const wrong = levelOf([node({ components: [{ id: 'c0', type: 'Mover', params: { move: vec3(0, 3, 0), speed: 1.6, smooth: true, offset: 0 } }] })])
    expect(firstMotionDifference(fingerprintMotion(before, TYPES, INLINE), fingerprintMotion(wrong, TYPES, INLINE))).not.toBeNull()
  })

  it('catches a lost phase, a wrong axis and a lost smoothing', () => {
    const base = moveTrack(vec3(0, 1, 0), 3, 4000)
    const before = levelOf([node({ components: [track({ keys: base, loop: 'loop', phaseMs: 1000 }, 'c0')] })])
    const noPhase = levelOf([node({ components: [{ id: 'c0', type: 'Mover', params: { move: vec3(0, 3, 0), speed: 1.5, smooth: true, offset: 0 } }] })])
    expect(firstMotionDifference(fingerprintMotion(before, TYPES, INLINE), fingerprintMotion(noPhase, TYPES, INLINE))).not.toBeNull()

    const spin = levelOf([node({ components: [track({ keys: spinTrack(vec3(0, 1, 0), 6000), loop: 'loop' }, 'c0')] })])
    const wrongAxis = levelOf([node({ components: [{ id: 'c0', type: 'Spinner', params: { axis: '+X', speed: 60, offset: 0 } }] })])
    expect(firstMotionDifference(fingerprintMotion(spin, TYPES, INLINE), fingerprintMotion(wrongAxis, TYPES, INLINE))).not.toBeNull()

    const flat = levelOf([node({ components: [{ id: 'c0', type: 'Mover', params: { move: vec3(0, 3, 0), speed: 1.5, smooth: false, offset: 0 } }] })])
    const smooth = levelOf([node({ components: [track({ keys: base, loop: 'loop' }, 'c0')] })])
    expect(firstMotionDifference(fingerprintMotion(smooth, TYPES, INLINE), fingerprintMotion(flat, TYPES, INLINE))).not.toBeNull()
  })

  it('catches a dropped mover, and says nothing about dropping a dead one', () => {
    const live = levelOf([node({ components: [track({ keys: moveTrack(vec3(0, 1, 0), 3, 4000), loop: 'loop' }, 'c0')] })])
    expect(firstMotionDifference(fingerprintMotion(live, TYPES, INLINE), fingerprintMotion(levelOf([node()]), TYPES, INLINE))).not.toBeNull()

    const dead = levelOf([node({ components: [track({ keys: [{ t: 0, position: vec3(0, 0, 0) }, { t: 0, position: vec3(0, 5, 0) }] }, 'c0')] })])
    const gone = structuredClone(dead)
    expect(migrateTracksIn(gone.nodes[0]!, 'x', INLINE, newMotionReport())).toBe(true)
    expect(firstMotionDifference(fingerprintMotion(dead, TYPES, INLINE), fingerprintMotion(gone, TYPES, INLINE))).toBeNull()
  })

  it('fingerprints through a placement, so a prefab’s mover is covered too', () => {
    const prefab: Node = { id: 'root', transform: { position: vec3(0, 0, 0) }, components: [track({ keys: moveTrack(vec3(0, 1, 0), 3, 4000), loop: 'loop' }, 'c0')] }
    const before: Level = { id: 'lv', config: {}, prefabs: { lift: prefab }, nodes: [{ id: 'n0', transform: { position: vec3(5, 0, 0) }, components: [], prefab: 'lift' }] }
    const after = structuredClone(before)
    expect(migrateTracksIn(after.prefabs!.lift!, 'lift', INLINE, newMotionReport())).toBe(true)
    const a = fingerprintMotion(before, TYPES, INLINE)
    expect(a.length, 'the placement resolves to the prefab root, so it is sampled').toBeGreaterThan(0)
    expect(firstMotionDifference(a, fingerprintMotion(after, TYPES, INLINE))).toBeNull()
  })
})
