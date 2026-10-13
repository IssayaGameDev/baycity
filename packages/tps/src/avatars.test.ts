// @vitest-environment happy-dom
import { entityId, vec3, type EntityId, type Vec3 } from '@mp/core'
import { DEFAULT_GAIT, PART_NAMES } from '@mp/humanoid'
import type { PhysicsBody, PhysicsWorld } from '@mp/physics'
import { THREE } from '@mp/render-three'
import { beforeAll, describe, expect, it } from 'vitest'

import type { AssemblyTiming } from './assemble'
import { createAvatars, type Avatars } from './avatars'
import type { CharacterPlacement } from './characterView'

/**
 * The bodies state machine (ADR 0065).
 *
 * This is the one part of phase 1 that was a rewrite rather than a move, and the part with the most ways to be
 * subtly wrong: a corpse that will not clear, a rig left invisible after a respawn, an assembly that never
 * finishes. Every gate below is one of those.
 *
 * Not covered: what a ragdoll or an assembly *looks* like. Those are unchanged code, and the physics they
 * depend on is `@mp/physics`'s own tests.
 */

/** A canvas 2D context, which happy-dom does not implement. Only what the nametag draws with. */
const stubCanvas2d = (): void => {
  const ctx = {
    font: '',
    textAlign: '',
    textBaseline: '',
    fillStyle: '',
    measureText: () => ({ width: 40 }),
    fillRect: () => {},
    fillText: () => {},
  }
  HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as HTMLCanvasElement['getContext']
}

/**
 * A physics world that hands out bodies which stay where they were put.
 *
 * The corpse paths need `addDynamicBody` and nothing else, and a real Rapier world would make these tests
 * async and slow for no extra coverage — nothing here asserts on how a part falls.
 */
const fakeWorld = (): PhysicsWorld & { made: number; removed: number } => {
  const w = {
    made: 0,
    removed: 0,
    addDynamicBody: (opts: { position: Vec3; rotation?: unknown }): PhysicsBody => {
      w.made += 1
      const handle = w.made
      return {
        colliderHandle: handle,
        setLinvel: () => {},
        translation: () => opts.position,
        rotation: () => ({ x: 0, y: 0, z: 0, w: 1 }),
        remove: () => {
          w.removed += 1
        },
      } as unknown as PhysicsBody
    },
  }
  return w as unknown as PhysicsWorld & { made: number; removed: number }
}

const TIMING: AssemblyTiming = { stagger: 0.05, fall: 0.1, height: 2 }
/** Longer than `6 * stagger + fall`, so one frame of it finishes any assembly. */
const PAST_THE_END = 6 * TIMING.stagger + TIMING.fall + 0.1

const placement = (isSelf: boolean, position = vec3(0, 1, 0)): CharacterPlacement => ({
  isSelf,
  position,
  yaw: 0,
  speed: 0,
  vy: 0,
  grounded: true,
  rising: false,
  carry: null,
  base: 0,
  name: isSelf ? 'me' : 'them',
  states: null,
})

const build = (
  opts: { world?: PhysicsWorld | null; ragdoll?: boolean } = {},
): { avatars: Avatars; scene: THREE.Scene } => {
  const scene = new THREE.Scene()
  return {
    scene,
    avatars: createAvatars({
      scene,
      gait: { ...DEFAULT_GAIT },
      timing: TIMING,
      world: () => opts.world ?? null,
      ...(opts.ragdoll === undefined ? {} : { ragdoll: opts.ragdoll }),
    }),
  }
}

/** Whether a rig is being drawn for `id` — every mesh under it shares the rig root's visibility. */
const rigVisible = (avatars: Avatars, id: EntityId, scene: THREE.Scene): boolean => {
  const pose = avatars.poseOf(id)
  if (pose === null) return false
  let visible = false
  scene.traverse((o) => {
    if (o.name === PART_NAMES[0]) visible = o.visible && (o.parent?.visible ?? false)
  })
  return visible
}

beforeAll(stubCanvas2d)

const ME = entityId(1)
const THEM = entityId(2)

describe('our own body', () => {
  it('draws a rig when alive and leaves it alone when dead', () => {
    const { avatars, scene } = build()
    avatars.drawSelf(ME, placement(true), 1 / 60, { dead: false, tickAlpha: 0, at: vec3(0, 1, 0) })
    expect(avatars.poseOf(ME)).not.toBeNull()

    // Dead: the rig is not upserted at all, so its pose is whatever it was — the corpse owns the picture and
    // a respawn only has to show the rig again.
    const before = avatars.poseOf(ME)
    avatars.drawSelf(ME, placement(true), 1 / 60, { dead: true, tickAlpha: 0, at: vec3(0, 1, 0) })
    expect(avatars.poseOf(ME)).toBe(before)
    // Hidden by `setSelfVisible`, not by `drawSelf` — visibility is settled once per frame after the camera is
    // placed, and the caller passes the camera's answer even while dead.
    avatars.setSelfVisible(ME, true)
    expect(rigVisible(avatars, ME, scene)).toBe(false)
  })

  /** The three-way rule. Getting this wrong is a rig that never comes back, which is the worst failure here. */
  it('hides the rig while assembling, and shows it once the body has landed', () => {
    const { avatars, scene } = build()
    avatars.reassemble()
    expect(avatars.assembling()).toBe(true)

    // A frame's worth: the rig is drawn (the parts fall toward its pose) but not shown.
    avatars.drawSelf(ME, placement(true), 1 / 60, { dead: false, tickAlpha: 0, at: vec3(0, 1, 0) })
    avatars.setSelfVisible(ME, true)
    expect(rigVisible(avatars, ME, scene)).toBe(false)

    // Past the end of the drop.
    avatars.drawSelf(ME, placement(true), PAST_THE_END, { dead: false, tickAlpha: 0, at: vec3(0, 1, 0) })
    expect(avatars.assembling()).toBe(false)
    avatars.setSelfVisible(ME, true)
    expect(rigVisible(avatars, ME, scene)).toBe(true)
  })

  it('lets the camera hide the rig on its own', () => {
    const { avatars, scene } = build()
    avatars.drawSelf(ME, placement(true), 1 / 60, { dead: false, tickAlpha: 0, at: vec3(0, 1, 0) })
    avatars.setSelfVisible(ME, false)
    expect(rigVisible(avatars, ME, scene)).toBe(false)
    avatars.setSelfVisible(ME, true)
    expect(rigVisible(avatars, ME, scene)).toBe(true)
  })
})

describe('dying', () => {
  it('refuses when no rig has been drawn yet', () => {
    const { avatars } = build({ world: fakeWorld() })
    // Nothing to fall apart, so the caller must stay alive — otherwise a player who dies on their first frame
    // is dead with no corpse and no rig.
    expect(avatars.die(ME, vec3(0, 1, 0), vec3())).toBe(false)
  })

  it('happens without a ragdoll when the game declared none', () => {
    const world = fakeWorld()
    const { avatars } = build({ world, ragdoll: false })
    avatars.drawSelf(ME, placement(true), 1 / 60, { dead: false, tickAlpha: 0, at: vec3(0, 1, 0) })

    expect(avatars.die(ME, vec3(0, 1, 0), vec3())).toBe(true)
    expect(world.made).toBe(0)
  })

  it('happens without a ragdoll before the world exists', () => {
    const { avatars } = build({ world: null })
    avatars.drawSelf(ME, placement(true), 1 / 60, { dead: false, tickAlpha: 0, at: vec3(0, 1, 0) })
    expect(avatars.die(ME, vec3(0, 1, 0), vec3())).toBe(true)
  })

  it('drops one body per part, and the respawn takes them all away', () => {
    const world = fakeWorld()
    const { avatars } = build({ world })
    avatars.drawSelf(ME, placement(true), 1 / 60, { dead: false, tickAlpha: 0, at: vec3(0, 1, 0) })
    expect(avatars.die(ME, vec3(0, 1, 0), vec3())).toBe(true)
    expect(world.made).toBe(PART_NAMES.length)

    avatars.reassemble()
    expect(world.removed).toBe(PART_NAMES.length)
    expect(avatars.assembling()).toBe(true)
  })

  /** What the camera follows while we are dead (ADR 0209). */
  it("hands over where the corpse's head is, and nothing without a corpse", () => {
    const { avatars } = build({ world: fakeWorld() })
    avatars.drawSelf(ME, placement(true), 1 / 60, { dead: false, tickAlpha: 0, at: vec3(0, 1, 0) })
    expect(avatars.corpseHead(1), 'alive').toBeNull()
    const head = avatars.partsOf(ME)!.head.position
    avatars.die(ME, vec3(0, 1, 0), vec3())
    avatars.capture()
    expect(avatars.corpseHead(1)).toEqual(head)
    avatars.reassemble()
    expect(avatars.corpseHead(1), 'respawned').toBeNull()

    const none = build({ world: fakeWorld(), ragdoll: false }).avatars
    none.drawSelf(ME, placement(true), 1 / 60, { dead: false, tickAlpha: 0, at: vec3(0, 1, 0) })
    none.die(ME, vec3(0, 1, 0), vec3())
    expect(none.corpseHead(1), 'a game that drops no ragdoll').toBeNull()
  })

  /** The camera must not be shoved by our own capsule or our own parts. */
  it('adds our parts to what the camera ignores', () => {
    const world = fakeWorld()
    const { avatars } = build({ world })
    expect(avatars.obstacles(99)).toEqual([99])

    avatars.drawSelf(ME, placement(true), 1 / 60, { dead: false, tickAlpha: 0, at: vec3(0, 1, 0) })
    avatars.die(ME, vec3(0, 1, 0), vec3())
    expect(avatars.obstacles(99)).toHaveLength(1 + PART_NAMES.length)
    expect(avatars.obstacles(99)[0]).toBe(99)
  })
})

describe('a peer', () => {
  const alive = { dead: false, tickAlpha: 0, teleports: 0 }
  const isDead = { dead: true, tickAlpha: 0, teleports: 0 }

  it('keeps their rig while no world exists to drop parts into', () => {
    const { avatars } = build({ world: null })
    avatars.drawPeer(THEM, placement(false), 1 / 60, alive)
    avatars.drawPeer(THEM, placement(false), 1 / 60, isDead)
    // No corpse could be built, so the rig is all there is — and it must not have been left hidden behind one.
    expect(avatars.poseOf(THEM)).not.toBeNull()
  })

  it('is not given a corpse before their rig has ever been drawn', () => {
    const world = fakeWorld()
    const { avatars } = build({ world })
    // Already dead when we joined: let them draw standing for one frame rather than seed a corpse from a pose
    // that does not exist.
    avatars.drawPeer(THEM, placement(false), 1 / 60, isDead)
    expect(world.made).toBe(0)
  })

  it('gets a corpse once dead, and it is taken away and reassembled on respawn', () => {
    const world = fakeWorld()
    const { avatars } = build({ world })
    avatars.drawPeer(THEM, placement(false), 1 / 60, alive)

    avatars.drawPeer(THEM, placement(false), 1 / 60, isDead)
    expect(world.made).toBe(PART_NAMES.length)
    // Still dead: no second corpse.
    avatars.drawPeer(THEM, placement(false), 1 / 60, isDead)
    expect(world.made).toBe(PART_NAMES.length)

    // Respawned. The corpse goes, and the body starts dropping back in.
    avatars.drawPeer(THEM, placement(false), 1 / 60, alive)
    expect(world.removed).toBe(PART_NAMES.length)
    // And it finishes rather than hiding them for ever.
    avatars.drawPeer(THEM, placement(false), PAST_THE_END, alive)
    avatars.drawPeer(THEM, placement(false), 1 / 60, alive)
    expect(avatars.poseOf(THEM)).not.toBeNull()
  })

  it('killed again mid-respawn keeps only the corpse', () => {
    const world = fakeWorld()
    const { avatars } = build({ world })
    avatars.drawPeer(THEM, placement(false), 1 / 60, alive)
    avatars.drawPeer(THEM, placement(false), 1 / 60, isDead)
    avatars.drawPeer(THEM, placement(false), 1 / 60, alive) // respawn: assembly starts
    avatars.drawPeer(THEM, placement(false), 1 / 60, isDead) // killed again

    // Two corpses built in total, one removed — and no assembly left running behind the second corpse, which
    // would have shown a body dropping in around a dead player.
    expect(world.made).toBe(2 * PART_NAMES.length)
    expect(world.removed).toBe(PART_NAMES.length)
    avatars.drawPeer(THEM, placement(false), PAST_THE_END, isDead)
    expect(world.removed).toBe(PART_NAMES.length)
  })

  it('takes their corpse with them when they leave the room', () => {
    const world = fakeWorld()
    const { avatars } = build({ world })
    avatars.drawPeer(THEM, placement(false), 1 / 60, alive)
    avatars.drawPeer(THEM, placement(false), 1 / 60, isDead)

    avatars.prune(new Set([ME]))

    expect(world.removed).toBe(PART_NAMES.length)
    expect(avatars.poseOf(THEM)).toBeNull()
  })
})

describe('disposing', () => {
  it('empties the scene and releases every loose body', () => {
    const world = fakeWorld()
    const { avatars, scene } = build({ world })
    avatars.drawSelf(ME, placement(true), 1 / 60, { dead: false, tickAlpha: 0, at: vec3(0, 1, 0) })
    avatars.die(ME, vec3(0, 1, 0), vec3())
    avatars.drawPeer(THEM, placement(false), 1 / 60, { dead: false, tickAlpha: 0, teleports: 0 })
    avatars.reassemble()

    avatars.dispose()

    expect(scene.children).toHaveLength(0)
    expect(avatars.poseOf(ME)).toBeNull()
    expect(avatars.assembling()).toBe(false)
  })
})
