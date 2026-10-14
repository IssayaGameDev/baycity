import { TICK_DT, vec3, type Vec3 } from '@mp/core'
import { CHAR_RADIUS, createAnimator, createLocomotion, DEFAULT_GAIT, FOOT_Y, RIG } from '@mp/humanoid'
import { componentOn, readData } from '@mp/components'
import type { WorldNode } from '@mp/content'
import { worldLabel, type LabelLine, type THREE } from '@mp/render-three'
import { startTpsClient } from '@mp/tps'

import { KEYBOARD_MODE } from './editorMode'
import { createHud } from './hud'
import { DEFAULT_KEYCAP_SHAPE, type KeycapShape } from './keycapGeometry'
import { DEFAULT_KEYCAP_LOOK, DEFAULT_PRESS, drawKeycaps, type KeycapLook, type PressFeel } from './keycaps'
import { createPopups, DEFAULT_POPUP, type PopupFeel } from './popups'
import { abbreviate, experienceForLevel, levelAt, maxSpeedAt, METRES_PER_STUD, rebirthMultiplierAt, shortAmount, type ProgressCurve } from './progression'
import { createRebirthWindow, rebirthView, type RebirthWindow } from './rebirthWindow'
import { keyboardSession, GAME_CURVE, GAME_KEYS, spawnOf, STAND_OFFSET, type KeyboardSession, type KeyboardTeleport } from './rules'
import { createTeleportWindow, teleportRows, type TeleportWindow } from './teleportWindow'
import { checkpointsOf, shownText, TEXT_FADE_SECONDS, type CheckpointStop } from './components/obstacle'
import { createStepper, stepsPerSecond } from './components/steps'
import { Treadmill, TREADMILL_STATE, treadmillStepValue, type TreadmillTick } from './components/treadmill'
import { padTop } from './components/wins'
import { qualifies, StepPad, type StepPadOffer } from './components/stepPad'
import { KeyboardStyle } from './data/keyboardStyle'
import { localKeyboardSave, withReached } from './save'

/**
 * Keyboard Escape, as an application (ADR 0069, ADR 0071).
 *
 * The shipped third-person game plus four things it knows nothing about: platforms carrying a `Keyboard`
 * component get keycaps, every cap somebody stands over is held down, **holding a direction on the ground earns
 * Experience by the step** (ADR 0081 — the keys are what you see, not what you earn), and standing on a
 * `WinsPad` **banks its Wins and sends you back to the spawn** (ADR 0073).
 *
 * The loop is three values and **only one is a speed**: **Experience** is the currency (+1 a key), **Level** is
 * derived from it, and **Max Speed** is derived from Level and is the actual velocity. The game being cloned
 * calls the currency "Speed", which is what made an earlier version treat a player at 345,510 as moving at
 * 345,510 — they were moving at 100 studs a second.
 *
 * Everything here goes through what ADR 0066 and ADR 0071 opened: the scene, a per-frame hook, the drawn rig
 * parts, and the 2D overlay. Not one field was added to `TpsClientOptions` or `ModeDescriptor`.
 *
 * **Still missing:** the click, the speed picker, anything Wins buy.
 */
const look: KeycapLook = { ...DEFAULT_KEYCAP_LOOK }
const shape: KeycapShape = { ...DEFAULT_KEYCAP_SHAPE }
const feel: PressFeel = { ...DEFAULT_PRESS }
const curve: ProgressCurve = { ...GAME_CURVE }
const pops: PopupFeel = { ...DEFAULT_POPUP }

/**
 * Survive a reload, through the adapter and nothing else (Kodjo's rule): this browser's storage now, platform accounts
 * later. Experience and Wins are this game's stats, not the platform's save shape.
 */
const saves = localKeyboardSave()
const saved = saves.load()
let experience = saved.experience
let wins = saved.wins
/** What a step pays (ADR 0082): the last `StepPad` taken, or the curve's one. */
let perStep = saved.perStep
/** The checkpoints reached, by level (ADR 0211). */
let reached = saved.reached
/** Rebirths taken (ADR 0221): what every step's XP is multiplied by, through the curve. */
let rebirths = saved.rebirths
/** Everything above, as it is now. */
const persist = (): void => saves.save({ experience, wins, perStep, reached, rebirths })
/** Cash-outs the rules reported this tick, banked here and popped on the next frame. */
const cashedOut: { wins: number; at: { x: number; y: number; z: number } }[] = []
/**
 * A debug stand-in for the speed picker the real game has (ADR 0071's known open): run at a chosen speed up to
 * Max Speed rather than always at Max. Off, you run at Max Speed. In studs/s, the game's unit.
 */
const speedPick = { enabled: false, studs: 12 }

/**
 * Steps taken and not yet paid out, on the ground and on a treadmill (ADR 0081, ADR 0080). Both accrue
 * fractionally per tick; the frame pays whole steps, one popup each saying what it paid.
 *
 * A tick spent on a treadmill is a treadmill tick, not also a ground tick, so holding a direction on one does
 * not pay twice. The stepper reports first in a tick (the movement slot) and the treadmill second (contacts), so
 * the ground steps of a tick that turns out to be on a treadmill are handed over here.
 */
let groundSteps = 0
let treadmillSteps = 0
/** The treadmill stood on this tick, for what a step is worth. `null` off one. */
let treadmillOn: TreadmillTick | null = null
/** When the treadmill last reported, so "on a treadmill now" is a recent report, not a stale flag. */
let treadmillSeenMs = -Infinity
const onTreadmillNow = (): boolean => performance.now() - treadmillSeenMs < 3 * TICK_DT * 1000
const TREADMILL_STATES: ReadonlySet<string> = new Set([TREADMILL_STATE])
const NO_STATES: ReadonlySet<string> = new Set()
/** The stepper's report for the tick in progress, held until the tick's contacts have said whether we are on a treadmill. */
let stepsThisTick = 0

/** The level being played's checkpoints and spawn, for the teleport window (ADR 0203); read as each level loads. */
let checkpoints: readonly CheckpointStop[] = []
let start: Vec3 = vec3(0, 3, 0)
/** Where the teleport window asked to go, until the rules take it on the next tick. */
let wantTeleport: KeyboardTeleport | null = null
/**
 * The level being played, by name, for what reached checkpoints are saved under — `null` until the client exists.
 * A trigger walked into before then (a spawn inside one) waits in `reachedEarly`.
 */
let levelName: string | null = null
const reachedEarly: WorldNode[] = []
/** The level's rules, for the obstacle the player is on (ADR 0212). */
let session: KeyboardSession | null = null
/**
 * The trigger the player was last inside, and when (ADR 0213): reported every tick inside it, so "inside now" is a
 * recent report — the treadmill's arrangement.
 */
let insideOf: WorldNode | null = null
let insideSeenMs = -Infinity
/** How much of each obstacle text shows, 0 to 1, fading toward the one shown (ADR 0213). Hidden until shown. */
const textShown = new Map<WorldNode, number>()
/** The teleport window, once it is made: told when a checkpoint is reached, so an open one opens the row then. */
let teleportWindow: TeleportWindow | null = null
/** The rebirth window (ADR 0221): one box on the left edge at a time, so each closes the other as it opens. */
let rebirthWindow: RebirthWindow | null = null
/** An Obstacle's trigger was walked into (ADR 0211): its checkpoint is reached for good, saved once. */
const reach = (node: WorldNode): void => {
  if (levelName === null) {
    if (!reachedEarly.includes(node)) reachedEarly.push(node)
    return
  }
  const stop = checkpoints.find((s) => s.node === node)
  if (stop === undefined) return
  const next = withReached(reached, levelName, stop.key)
  if (next === reached) return
  reached = next
  persist()
  teleportWindow?.refresh()
}
const isReached = (key: string): boolean => levelName !== null && (reached[levelName] ?? []).includes(key)
/** Debug (Kodjo's call, for testing levels): every checkpoint open in the teleport window. Reaches and saves nothing. */
const unlock = { all: false }
/**
 * Debug (Kodjo's call): a respawn puts you at the checkpoint of the obstacle you were on — the last trigger walked into
 * or checkpoint teleported to — facing its way, rather than at the spawn. From the spawn, the spawn.
 */
const respawnHere = { on: false }

const client = await startTpsClient({
  ...KEYBOARD_MODE,
  /**
   * None of the platform's debug folders (ADR 0075). Kodjo's call: this game is deep in its own loop, and a
   * pane of camera, gait and sky sliders is twelve folders between you and the three below.
   */
  debugFolders: [],
  /**
   * On a treadmill the character **runs in place** (ADR 0080, amended): the shared gait is handed the tuned run
   * speed while the state is set, so the legs cycle at their natural stride and nothing else moves. The state
   * travels (ADR 0064), so a peer on a treadmill runs in place on every screen. The same wrap-the-animator move
   * as ADR 0063's dash: nothing was added to `AnimationInput`.
   */
  states: [TREADMILL_STATE],
  playerStates: () => (onTreadmillNow() ? TREADMILL_STATES : NO_STATES),
  animator: (gait, seed, states) => {
    const base = createAnimator(gait, seed)
    return {
      step: (input, dt) => base.step(states().has(TREADMILL_STATE) ? { ...input, speed: gait.runSpeed, grounded: true, rising: false } : input, dt),
    }
  },
  /**
   * The shipped gait, with the inertia layer told to believe no more than the 55 m/s² it was tuned at
   * (ADR 0079). At this game's speeds every stick input hits the controller's 150 m/s² cap, and uncapped the
   * arms went to 70° on every start and stop.
   */
  gait: {
    ...DEFAULT_GAIT,
    inertiaAccelCap: 55,
    // Sideways lag rolls the arms — one out, one across the chest — and tilts the torso and head with them, and
    // at this game's speeds every strafe and turn is a hard sideways acceleration. A third of the fore-aft
    // response, for the whole layer at once: about 16° on the arms and 5° on the torso at the cap.
    inertiaLateral: 0.35,
    // 5.5 m/s over a 1.7 m stride is 3.24 strides a second; hold that, and let the steps get long instead.
    maxStrideRate: 3.25,
  },
  /**
   * The game's own session, with the one callback the platform has no word for. The rules stay headless — the
   * editor calls them with no callback and still teleports — and the client hears about the payout here.
   */
  session: (loaded, opts) => {
    checkpoints = checkpointsOf(loaded, STAND_OFFSET)
    start = spawnOf(loaded)
    textShown.clear()
    session = keyboardSession(loaded, {
      ...opts,
      onReached: (node) => {
        insideOf = node
        insideSeenMs = performance.now()
        reach(node)
      },
      // The debug pane's respawn at the obstacle you were on.
      respawnTo: (on) => {
        const stop = respawnHere.on && on !== null ? checkpoints.find((s) => s.node === on) : undefined
        return stop === undefined ? null : { position: stop.position, yaw: stop.yaw, obstacle: stop.node }
      },
      // The teleport window's pick, handed over once (ADR 0203).
      requested: () => {
        const to = wantTeleport
        wantTeleport = null
        return to
      },
      onCashOut: (paid, node) => cashedOut.push({ wins: paid, at: padTop(node) }),
      // A pad's offer, every tick stood on it. Taken when the Wins allow; nothing otherwise (Kodjo's call).
      onStepPad: (offer: StepPadOffer) => {
        if (!qualifies(wins, offer) || offer.perStep === perStep) return
        perStep = offer.perStep
        persist()
      },
      // Once per tick while standing on it: this tick's steps are the treadmill's, at its tier, whether or not a
      // direction was held (ADR 0080, ADR 0081).
      onTreadmill: (on: TreadmillTick) => {
        treadmillOn = on
        treadmillSeenMs = performance.now()
        treadmillSteps += stepsPerSecond(levelAt(experience, curve).level, curve) * TICK_DT
        stepsThisTick = 0 // the stepper's report for this tick, if any, is superseded
      },
    })
    return session
  },
  /**
   * The locomotion, and the Stepper bound to this client (ADR 0081): held input on the ground becomes steps,
   * banked per tick and paid out per frame below.
   */
  playerDefs: (host) => [
    createLocomotion(host),
    createStepper({
      curve: () => curve,
      // The cadence follows Level (ADR 0081, amended). Closed form, so a read per tick is cheap.
      level: () => levelAt(experience, curve).level,
      onSteps: (steps) => {
        // Settle the previous tick's report first: it was on the ground unless a treadmill claimed it.
        groundSteps += stepsThisTick
        stepsThisTick = steps
      },
    }),
  ],
})
// The key geometry is the game's, not each platform's (ADR 0115): one pitch for the level. A board's colours are its
// Keyboard Style's (ADR 0182), read from the level's data assets; one that will not read leaves the plain look.
const styleOf = (id: string) => {
  try {
    return readData(KeyboardStyle, client.data(id), id)
  } catch (e) {
    console.warn(`keyboard style ${id}: ${String(e)}`)
    return undefined
  }
}
const keycaps = drawKeycaps(client, look, shape, feel, () => GAME_KEYS, styleOf)
const hud = createHud(client, curve)
const popups = createPopups(client, pops)
levelName = client.levelName
for (const node of reachedEarly.splice(0)) reach(node)
teleportWindow = createTeleportWindow(client, {
  rows: () => teleportRows(start, checkpoints, (key) => unlock.all || isReached(key)),
  go: (to) => {
    wantTeleport = to
  },
  onOpen: () => rebirthWindow?.close(),
})
/**
 * Rebirth (ADR 0221, Kodjo's calls): at the Level the next one needs, Experience and so Level go back to 0 and every
 * step pays the curve's multiplier from then on. Nothing else resets — Wins, the step pad, the checkpoints reached,
 * where you stand. No Wins are paid.
 */
rebirthWindow = createRebirthWindow(client, {
  view: () => rebirthView(levelAt(experience, curve).level, rebirths, curve),
  rebirth: () => {
    if (!rebirthView(levelAt(experience, curve).level, rebirths, curve).ready) return
    rebirths += 1
    experience = 0
    persist()
  },
  onOpen: () => teleportWindow?.close(),
})

/**
 * How far the torso part's centre sits above the ground when the character stands: its pivot at the hips, plus
 * half its own height, less the foot line. A rig constant, so the ground is read off the torso rather than off
 * the feet.
 */
const TORSO_ABOVE_GROUND = RIG.body.pivot.y + RIG.body.meshOffset.y - FOOT_Y

/**
 * Where a character's weight is: under the torso, at ground level.
 *
 * Ground level is the **torso's height less a rig constant**, not the drawn feet. It was the feet — the lower of
 * the two soles — and that broke the moment the stride was allowed to grow past `runSpeed` (ADR 0079): a leg
 * reaching for a footfall metres ahead is clamped by the IK to a line from the hip that ends above the ground,
 * so at 32 m/s the lower sole floated more than the 0.35 m band above the keys two frames in three, and presses
 * came in bursts of four. The torso bobs a few centimetres and crouches on landing, all inside the band.
 *
 * Taken from the **drawn** parts rather than from the simulation, so it is one source for us and for every
 * peer, and it follows the rig you can see rather than the capsule you cannot.
 */
const standing = (parts: NonNullable<ReturnType<typeof client.partsOf>>): { x: number; y: number; z: number } => ({
  x: parts.body.position.x,
  y: parts.body.position.y - TORSO_ABOVE_GROUND,
  z: parts.body.position.z,
})

/**
 * Where each character's sole was last frame, so this frame's presses sweep the path rather than sample the
 * end of it. Entries for characters no longer drawn are dropped each frame.
 */
type CharacterId = NonNullable<ReturnType<typeof client.id>>
const lastSole = new Map<CharacterId, { x: number; y: number; z: number }>()

/**
 * A sign over every `StepPad` and every `Treadmill` (ADR 0082), from the node's own parameters: a pad says
 * `+N/step` and what it requires; a treadmill says its name and `×N/step`. Built once, on the first frame the
 * level exists — it arrives with the first snapshot (ADR 0055).
 */
const signs: THREE.Group[] = []
let signsBuilt = false
const buildSigns = (): void => {
  if (signsBuilt) return
  const loaded = client.level()
  if (loaded === null) return
  signsBuilt = true
  for (const node of loaded.nodes) {
    const pad = componentOn(node.components, StepPad)
    const mill = componentOn(node.components, Treadmill)
    const lines: LabelLine[] | null =
      pad !== undefined
        ? [
            { text: `+${abbreviate(pad.perStep)}/step`, size: 44, color: '#7CFF5A' },
            { text: `Requires ${abbreviate(pad.requiresWins)} Wins`, size: 24, color: '#FFE7A8' },
          ]
        : mill !== undefined
          ? [
              { text: mill.name, size: 44, color: '#FFE7A8' },
              { text: `×${abbreviate(mill.multiplier)}/step`, size: 24, color: '#7CFF5A' },
            ]
          : null
    if (lines === null) continue
    // In the world, not over it: a sign hides behind a wall and behind a player. Kept out of the AO prepass, or
    // it ghosts (ADR 0082).
    const sign = worldLabel(lines, { heightM: 0.9, background: null, depth: 'world' })
    const top = padTop(node)
    sign.position.set(top.x, top.y + 1.1, top.z)
    client.scene.add(sign)
    client.excludeFromAO(sign)
    signs.push(sign)
  }
}

/**
 * The pads' materials (ADR 0082): each pad names, in the editor, what it wears while its value is the one you
 * are on and what it wears otherwise. Swapped onto the pads' meshes whenever the chosen value changes. A pad
 * that names nothing keeps the material its Renderer gave it.
 */
const padOriginal = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
let styledFor = -1
const stylePads = (): void => {
  if (styledFor === perStep) return
  const loaded = client.level()
  if (loaded === null) return
  styledFor = perStep
  for (const node of loaded.nodes) {
    const pad = componentOn(node.components, StepPad)
    if (pad === undefined) continue
    const wanted = pad.perStep === perStep ? pad.activeMaterial : pad.idleMaterial
    for (const mesh of client.meshesOf(node)) {
      if (!padOriginal.has(mesh)) padOriginal.set(mesh, mesh.material)
      const material = wanted === '' ? null : client.material(wanted)
      mesh.material = material ?? padOriginal.get(mesh)!
    }
  }
}

/** Written back on a timer, not per step: steps pay several times a second, and each would be a save. */
let sinceSave = 0
const SAVE_EVERY = 3

client.onFrame((dt) => {
  const seen = new Set<CharacterId>()
  /** Press every cap under this character between where it was last frame and where it is now. */
  const press = (id: CharacterId, parts: NonNullable<ReturnType<typeof client.partsOf>>): readonly { x: number; y: number; z: number }[] => {
    const sole = standing(parts)
    const struck = keycaps.sweep(lastSole.get(id) ?? null, sole, CHAR_RADIUS)
    lastSole.set(id, sole)
    seen.add(id)
    return struck
  }
  const me = client.id()
  if (me !== null) {
    const parts = client.partsOf(me)
    // Keys press under us as under everyone. They pay nothing (ADR 0081): the steps below do.
    if (parts !== null) press(me, parts)
  }
  for (const peer of client.peers()) {
    const parts = client.partsOf(peer.id)
    if (parts !== null) press(peer.id, parts)
  }
  for (const id of lastSole.keys()) if (!seen.has(id)) lastSole.delete(id)

  // The one obstacle text ahead of us (ADR 0213, Kodjo's calls): every one starts hidden, and each fades toward shown
  // or hidden over `TEXT_FADE_SECONDS`.
  const ownParts = me === null ? null : client.partsOf(me)
  const current = session?.currentObstacle() ?? null
  const inside = current !== null && insideOf === current && performance.now() - insideSeenMs < 3 * TICK_DT * 1000
  const ahead = ownParts === null ? null : shownText(checkpoints, current, inside, standing(ownParts))
  for (const stop of checkpoints)
    for (const [which, node] of [
      ['safeZone', stop.safeZoneText],
      ['requiredLevel', stop.requiredLevelText],
    ] as const) {
      if (node === undefined) continue
      const want = ahead !== null && ahead.stop === stop && ahead.which === which ? 1 : 0
      const was = textShown.get(node) ?? 0
      const step = dt / TEXT_FADE_SECONDS
      const now = want > was ? Math.min(want, was + step) : Math.max(want, was - step)
      textShown.set(node, now)
      client.textShown(node, now)
    }

  // Pay out whole steps, from the feet: ground steps at a key's worth (ADR 0081), treadmill steps at the tier's
  // (ADR 0080). Kodjo's call: popups on, one per step, saying what the step paid.
  const payOut = (pending: number, each: number): number => {
    const steps = Math.floor(pending)
    if (steps < 1 || me === null) return pending
    experience += steps * each
    const parts = client.partsOf(me)
    if (parts !== null) popups.burst(Array.from({ length: steps }, () => standing(parts)), `+${shortAmount(each)}`)
    return pending - steps
  }
  // Every tick before this frame is complete, contacts included, so the last report is settled and on the ground.
  groundSteps += stepsThisTick
  stepsThisTick = 0
  // Every step's worth times the rebirths' multiplier (ADR 0221): `1 × stepPad × treadmill × rebirth` so far.
  const reborn = rebirthMultiplierAt(rebirths, curve)
  groundSteps = payOut(groundSteps, perStep * reborn)
  if (treadmillOn !== null) treadmillSteps = payOut(treadmillSteps, treadmillStepValue(perStep, treadmillOn) * reborn)
  // The tick already put us back at the spawn; the payout is what is left to show. Popped from the pad we left.
  for (const cash of cashedOut) {
    wins += cash.wins
    popups.burst([cash.at], `+${cash.wins} Wins`)
  }
  cashedOut.length = 0

  keycaps.update(dt)
  popups.update(dt)
  buildSigns()
  stylePads()

  const at = levelAt(experience, curve)
  // The speed you run at: Max Speed for your Level, or the debug pick, which cannot exceed it (as the real
  // game's picker cannot). In studs/s for the HUD, in m/s for the controller.
  const maxStuds = maxSpeedAt(at.level, curve)
  const speedStuds = speedPick.enabled ? Math.min(speedPick.studs, maxStuds) : maxStuds
  hud.set(experience, at.level, at.into, at.next, speedStuds)
  hud.setWins(wins)
  if (levelPick.level !== at.level) {
    levelPick.level = at.level
    levelSlider.refresh()
  }
  // Written into the **client's** live tuning — the object the controller reads. It went into the descriptor's
  // object for fifty levels and changed nothing: the client copies that on the way in (ADR 0057, ADR 0071's
  // correction).
  client.tuning.moveSpeed = speedStuds * METRES_PER_STUD

  sinceSave += dt
  if (sinceSave >= SAVE_EVERY) {
    sinceSave = 0
    persist()
  }
})

/**
 * The two folders this game adds (ADR 0075). Kodjo's list, nothing else: Movement holds the two acceleration
 * caps (ADR 0078); Progression holds the two resets, the Level (ADR 0187) and a Wins grant. The curve, the keycap
 * press feel and the popup feel have defaults and no sliders — nobody asked for sliders.
 */
// The movement numbers this game owns (ADR 0078, ADR 0096): how hard a fast character may lose or redirect
// speed, and how steeply that grows with speed. Their own folder — nothing to do with progression.
//
// Gaining speed has no slider because it has no ceiling: a start is instant at every speed, which is what the
// genre does. `ground brake` and `air` are quoted at ACCEL_REF_SPEED (15 m/s) and scale from there.
const movement = client.debugPane.addFolder({ title: 'Movement', expanded: false })
movement.addBinding(client.tuning, 'groundBrakeMaxAccel', { min: 20, max: 1000, step: 5, label: 'ground brake m/s²' })
movement.addBinding(client.tuning, 'airMaxAccel', { min: 10, max: 500, step: 5, label: 'air accel m/s²' })
// Air drag (ADR 0107): the fraction of horizontal speed lost per second while airborne, stick or no stick.
// 0 = off (the other games), 0.5 = half a second's worth per second. Not an m/s², so it holds at every Level.
movement.addBinding(client.tuning, 'airDrag', { min: 0, max: 4, step: 0.05, label: 'air drag /s' })
// 0 = fixed ceiling (unusable past a few Levels), 0.5 = grows with √speed, 1 = constant time, no weight.
movement.addBinding(client.tuning, 'maxAccelScaling', { min: 0, max: 1, step: 0.05, label: 'weight vs speed' })
// The speed picker's debug stand-in: on, you run at this many studs/s, capped at Max Speed.
movement.addBinding(speedPick, 'enabled', { label: 'pick speed' })
movement.addBinding(speedPick, 'studs', { min: 1, max: 1000, step: 1, label: 'speed studs/s' })

const loop = client.debugPane.addFolder({ title: 'Progression', expanded: false })
loop.addButton({ title: 'Reset experience' }).on('click', () => {
  experience = 0
  persist()
})
loop.addButton({ title: 'Reset wins' }).on('click', () => {
  wins = 0
  persist()
})
// Set the Level outright (Kodjo's call, in place of an XP grant): Experience goes to exactly where that Level
// starts. It follows the Level as it is earned (the frame loop refreshes it), and a value that already matches
// — that refresh itself — changes nothing.
const levelPick = { level: levelAt(experience, curve).level }
const levelSlider = loop.addBinding(levelPick, 'level', { min: 0, max: 500, step: 1, label: 'level' })
levelSlider.on('change', (e) => {
  const level = Math.round(e.value)
  if (levelAt(experience, curve).level !== level) experience = experienceForLevel(level, curve)
  if (e.last) persist()
})
// The same for Wins: the step pads are gated on them, and earning 50K by running is not a debug workflow.
const grantWins = { amount: 100 }
loop.addBinding(grantWins, 'amount', { min: 0, step: 1, label: 'grant Wins' })
loop.addButton({ title: 'Add wins' }).on('click', () => {
  wins += Math.max(0, Math.floor(grantWins.amount))
  persist()
})
loop.addBinding(unlock, 'all', { label: 'unlock checkpoints' }).on('change', () => teleportWindow?.refresh())
loop.addBinding(respawnHere, 'on', { label: 'respawn at checkpoint' })
