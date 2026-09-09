import { vec3, type EntityId, type Vec3 } from '@mp/core'
import { partTransforms, type AnimatorFactory, type GaitTuning } from '@mp/humanoid'
import type { PhysicsWorld } from '@mp/physics'
import type { THREE } from '@mp/render-three'

import { createAssembly, type Assembly, type AssemblyTiming } from './assemble'
import { createCharacterViews, PEER_COLORS, SELF_COLORS, type CharacterPlacement, type CharacterViews } from './characterView'
import { createRagdoll, type Ragdoll } from './ragdoll'

/**
 * Every body on screen: the rigs, the corpses, and the spawn assemblies that put a body back together
 * (ADR 0065).
 *
 * These were 127 interleaved lines in `@mp/game-client`'s render loop, and interleaved is the point — a corpse
 * suppresses an assembly, an assembly hides a rig, a death needs the pose the rig was last *drawn* in, and all
 * three want the same interpolation alpha. Split across a host and a package, the host would have had to know
 * that order. Kept together, the order is the module.
 *
 * It is also why none of this can be the platform's: "a death is ten cuboids falling over" is a game's
 * opinion, and a game with a different body has no use for any of it.
 *
 * **The netcode stays outside.** Nothing here reads a flag byte or a base index. A caller says whether a peer
 * is dead and where they are; this decides what that looks like.
 */
export interface Avatars {
  /** Our own body for this frame: the rig if we are alive, the corpse if we are not, plus any assembly. */
  drawSelf: (id: EntityId, placement: CharacterPlacement, dt: number, opts: SelfFrame) => void
  /**
   * Whether our rig is drawn, settled once per frame **after the camera has been placed**.
   *
   * Three things want a say and only one is the caller's: `cameraSays` is false when the camera ends up inside
   * us. The other two — dead, and a body that has not finished landing — are this module's own state, which is
   * why the `&&` lives here rather than at the call site. Called after `drawSelf` because the camera is placed
   * after the bodies are drawn, and a frame that hid the rig on last frame's camera would flicker.
   */
  setSelfVisible: (id: EntityId, cameraSays: boolean) => void
  /**
   * One peer's body for this frame.
   *
   * `dead` is the only thing about their death that travels (ADR 0019); the corpse is built here, from the
   * pose this client last drew them in, so no part position ever goes on the wire and every viewer's corpse
   * lands somewhere different.
   */
  drawPeer: (id: EntityId, placement: CharacterPlacement, dt: number, opts: PeerFrame) => void
  /** Drop everyone not in `keep` — players who left the room, and whatever they were mid-way through. */
  prune: (keep: Set<EntityId>) => void
  /**
   * Our death: the rig becomes loose bodies in exactly the pose it was in.
   *
   * `false` means no rig has been drawn yet and so there is nothing to fall apart — the caller should stay
   * alive. With `ragdoll: false` a death still happens and this still returns `true`; there is simply nothing
   * loose to look at.
   */
  die: (id: EntityId, at: Vec3, velocity: Vec3) => boolean
  /** Our respawn, and our first spawn: the corpse goes, and the body starts dropping back in. */
  reassemble: () => void
  /** Whether our body is still arriving. */
  assembling: () => boolean
  /** After the world has stepped: every loose body's new pose, for the render loop to interpolate from. */
  capture: () => void
  /**
   * What the camera must not be shoved by: our own capsule, our own corpse, and **every** corpse.
   *
   * A living peer is a kinematic capsule and does move the camera, deliberately. A ragdoll is a visual whose
   * position no two clients agree on, and ten cuboids tumbling round your feet because somebody died next to
   * you should not shove your view. Read fresh per query, since corpses come and go.
   */
  obstacles: (ownCollider: number) => number[]
  /** The pose a rig was last drawn in — what a corpse is seeded from, and what an assembly falls toward. */
  poseOf: CharacterViews['poseOf']
  /** The same, in world space, for anything a game wants to pin to a body (ADR 0066). */
  partsOf: CharacterViews['partsOf']
  /** Peers who left mid-teleport, for the caller that knows they teleported. */
  resetMotion: CharacterViews['resetMotion']
  dispose: () => void
}

export interface SelfFrame {
  dead: boolean
  /** Where we are between the last two sim ticks, for the corpse's bodies. */
  tickAlpha: number
  /** Where the rig is in world space — what the assembly's parts fall toward. */
  at: Vec3
}

export interface PeerFrame {
  dead: boolean
  tickAlpha: number
}

export interface AvatarsOptions {
  scene: THREE.Scene
  /**
   * Shared by every character's animator and read fresh each frame, so mutating it retunes everyone live.
   * Feel is Kodjo's call and describing it in words is slow (ADR 0018).
   */
  gait: GaitTuning
  /** The game's animator, if it has one of its own (ADR 0063). */
  makeAnimator?: AnimatorFactory
  /** Live, because the debug pane binds it: a death dialled by eye applies to the next one. */
  timing: AssemblyTiming
  /**
   * The client's physics world, once it exists.
   *
   * A getter, because the world arrives with the first snapshot and this is built before it. A peer who dies
   * before then keeps their rig for a frame.
   */
  world: () => PhysicsWorld | null
  /** Whether a death drops a jointed body at all (ADR 0059). A game whose character is not one says false. */
  ragdoll?: boolean
}

export const createAvatars = ({
  scene,
  gait,
  makeAnimator,
  timing,
  world,
  ragdoll: ragdollEnabled = true,
}: AvatarsOptions): Avatars => {
  const views = createCharacterViews(scene, gait, makeAnimator)

  /** Our corpse. Local and visual only — nothing about a death goes on the wire. */
  let ragdoll: Ragdoll | null = null
  /** Our body dropping in, a pair of parts at a time. Owns whether our rig is drawn while it runs. */
  let assembly: Assembly | null = null
  let assembledFor = 0
  /** Whether we were drawn dead this frame, so `setSelfVisible` needs no second argument for it. */
  let selfDead = false

  /** One corpse per dead peer. */
  const peerRagdolls = new Map<EntityId, Ragdoll>()
  /**
   * One assembly per peer whose body is dropping back in. Same trigger as the corpse — the *falling* edge of
   * their dead flag — and the same timing, so a respawn looks the same from outside as it does to its owner.
   */
  const peerAssemblies = new Map<EntityId, { assembly: Assembly; elapsed: number }>()

  const dropPeerAssembly = (id: EntityId): void => {
    const spawning = peerAssemblies.get(id)
    if (spawning === undefined) return
    spawning.assembly.dispose()
    peerAssemblies.delete(id)
  }

  return {
    poseOf: views.poseOf,
    partsOf: views.partsOf,
    resetMotion: views.resetMotion,

    assembling: () => assembly !== null,

    reassemble: () => {
      ragdoll?.dispose()
      ragdoll = null
      assembly?.dispose()
      assembly = createAssembly({ scene, look: { colors: SELF_COLORS } })
      assembledFor = 0
    },

    die: (id, at, velocity) => {
      const pose = views.poseOf(id)
      if (pose === null) return false // no rig drawn yet; nothing to fall apart
      const w = world()
      if (!ragdollEnabled || w === null) return true
      ragdoll = createRagdoll({
        world: w,
        scene,
        transforms: partTransforms(pose, at),
        velocity,
        look: { colors: SELF_COLORS },
      })
      return true
    },

    capture: () => {
      ragdoll?.capture()
      for (const corpse of peerRagdolls.values()) corpse.capture()
    },

    obstacles: (ownCollider) => {
      const skip = [ownCollider, ...(ragdoll?.colliders ?? [])]
      for (const corpse of peerRagdolls.values()) skip.push(...corpse.colliders)
      return skip
    },

    setSelfVisible: (id, cameraSays) => {
      views.setVisible(id, !selfDead && assembly === null && cameraSays)
    },

    drawSelf: (id, placement, dt, { dead, tickAlpha, at }) => {
      selfDead = dead
      // Dead: the corpse owns the picture. The rig is left in place and simply not drawn, so a respawn only
      // has to show it again.
      if (dead) ragdoll?.sync(tickAlpha)
      else views.upsert(id, placement, dt)

      // Assembling: the animator above has already run, so the falling parts have a live pose to arrive at —
      // a player already walking when they respawn has their body land around them.
      if (!dead && assembly !== null) {
        assembledFor += dt
        const pose = views.poseOf(id)
        if (pose === null || assembly.draw(partTransforms(pose, at), assembledFor, timing)) {
          assembly.dispose()
          assembly = null
        }
      }

    },

    drawPeer: (id, placement, dt, { dead, tickAlpha }) => {
      const at = placement.position
      let corpse = peerRagdolls.get(id)

      if (corpse !== undefined && !dead) {
        // They respawned. The corpse goes and the body drops back in, exactly as it does for us.
        corpse.dispose()
        peerRagdolls.delete(id)
        corpse = undefined
        // Their position just jumped to a checkpoint. Differenced, that teleport reads as a sprint, and the
        // assembly would fall toward whatever pose that put the animator in.
        views.resetMotion(id, at)
        dropPeerAssembly(id)
        peerAssemblies.set(id, { assembly: createAssembly({ scene, look: { colors: PEER_COLORS } }), elapsed: 0 })
      }

      const w = world()
      if (corpse === undefined && dead && w !== null) {
        const pose = views.poseOf(id)
        // No pose means their rig has never been drawn — a peer who was already dead when we joined. Let them
        // draw standing for one frame; the corpse goes up on the next.
        if (pose !== null) {
          corpse = createRagdoll({
            world: w,
            scene,
            transforms: partTransforms(pose, at),
            velocity: views.velocityOf(id) ?? vec3(),
            look: { colors: PEER_COLORS },
          })
          peerRagdolls.set(id, corpse)
          views.setVisible(id, false)
          // Killed again mid-assembly: the corpse owns the picture from here.
          dropPeerAssembly(id)
        }
      }

      // Dead: the corpse owns the picture, and the rig is left hidden and un-animated behind it.
      if (corpse !== undefined) corpse.sync(tickAlpha)
      else views.upsert(id, placement, dt)

      const spawning = corpse === undefined ? peerAssemblies.get(id) : undefined
      if (spawning !== undefined) {
        views.setVisible(id, false)
        spawning.elapsed += dt
        const pose = views.poseOf(id)
        if (pose === null || spawning.assembly.draw(partTransforms(pose, at), spawning.elapsed, timing)) {
          spawning.assembly.dispose()
          peerAssemblies.delete(id)
          views.setVisible(id, true)
        }
      }
    },

    prune: (keep) => {
      views.prune(keep)
      // A player who leaves mid-death or mid-respawn takes both with them; `views.prune` only knows rigs.
      for (const [id, corpse] of peerRagdolls)
        if (!keep.has(id)) {
          corpse.dispose()
          peerRagdolls.delete(id)
        }
      for (const [id, spawning] of peerAssemblies)
        if (!keep.has(id)) {
          spawning.assembly.dispose()
          peerAssemblies.delete(id)
        }
    },

    dispose: () => {
      views.dispose()
      ragdoll?.dispose()
      ragdoll = null
      assembly?.dispose()
      assembly = null
      for (const corpse of peerRagdolls.values()) corpse.dispose()
      peerRagdolls.clear()
      for (const spawning of peerAssemblies.values()) spawning.assembly.dispose()
      peerAssemblies.clear()
    },
  }
}
