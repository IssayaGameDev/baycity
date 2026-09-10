import { CHAR_RADIUS, DEFAULT_GAIT, FOOT_Y, RIG } from '@mp/humanoid'
import { startTpsClient } from '@mp/tps'

import { KEYBOARD_MODE } from './editorMode'
import { createHud } from './hud'
import { DEFAULT_KEYCAP_SHAPE, type KeycapShape } from './keycapGeometry'
import { DEFAULT_KEYCAP_LOOK, DEFAULT_PRESS, drawKeycaps, type KeycapLook, type PressFeel } from './keycaps'
import { createPopups, DEFAULT_POPUP, type PopupFeel } from './popups'
import { DEFAULT_CURVE, levelAt, loadExperience, maxSpeedMps, saveExperience, type ProgressCurve } from './progression'
import { keyboardSession } from './rules'
import { loadWins, padTop, saveWins } from './wins'

/**
 * Keyboard Escape, as an application (ADR 0069, ADR 0071).
 *
 * The shipped third-person game plus four things it knows nothing about: platforms carrying a `Keyboard`
 * component get keycaps, every cap somebody stands over is held down, **striking one earns Experience**, and
 * standing on a `WinsPad` **banks its Wins and sends you back to the spawn** (ADR 0073).
 *
 * The loop is three values and **only one is a speed**: **Experience** is the currency (+1 a key), **Level** is
 * derived from it, and **Max Speed** is derived from Level and is the actual velocity. The game being cloned
 * calls the currency "Speed", which is what made an earlier version treat a player at 345,510 as moving at
 * 345,510 — they were moving at 100 studs a second.
 *
 * Everything here goes through what ADR 0066 and ADR 0071 opened: the scene, a per-frame hook, the drawn rig
 * parts, and the 2D overlay. Not one field was added to `TpsClientOptions` or `ModeDescriptor`.
 *
 * **Still missing:** the click, the speed picker, anything Wins buy, rebirth.
 */
const look: KeycapLook = { ...DEFAULT_KEYCAP_LOOK }
const shape: KeycapShape = { ...DEFAULT_KEYCAP_SHAPE }
const feel: PressFeel = { ...DEFAULT_PRESS }
const curve: ProgressCurve = { ...DEFAULT_CURVE }
const pops: PopupFeel = { ...DEFAULT_POPUP }

/** Survive a reload. The game's own keys: Experience and Wins are this game's stats, not the platform's save shape. */
let experience = loadExperience()
let wins = loadWins()
/** Cash-outs the rules reported this tick, banked here and popped on the next frame. */
const cashedOut: { wins: number; at: { x: number; y: number; z: number } }[] = []

const client = await startTpsClient({
  ...KEYBOARD_MODE,
  /**
   * None of the platform's debug folders (ADR 0075). Kodjo's call: this game is deep in its own loop, and a
   * pane of camera, gait and sky sliders is twelve folders between you and the three below.
   */
  debugFolders: [],
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
  session: (loaded, opts) => keyboardSession(loaded, { ...opts, onCashOut: (paid, node) => cashedOut.push({ wins: paid, at: padTop(node) }) }),
})
const keycaps = drawKeycaps(client, look, shape, feel)
const hud = createHud(client, curve)
const popups = createPopups(client, pops)

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

/** Written back on a timer, not per key: a struck cap is a `localStorage` write and there are several a second. */
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
    if (parts !== null) {
      // Only ours earns, and only ours pops. Everybody's presses are drawn; one player's are paid for.
      const struck = press(me, parts)
      if (struck.length > 0) {
        experience += struck.length * curve.perKey
        popups.burst(struck, `+${curve.perKey}`)
      }
    }
  }
  for (const peer of client.peers()) {
    const parts = client.partsOf(peer.id)
    if (parts !== null) press(peer.id, parts)
  }
  for (const id of lastSole.keys()) if (!seen.has(id)) lastSole.delete(id)
  // The tick already put us back at the spawn; the payout is what is left to show. Popped from the pad we left.
  for (const cash of cashedOut) {
    wins += cash.wins
    popups.burst([cash.at], `+${cash.wins} Wins`)
  }
  cashedOut.length = 0

  keycaps.update(dt)
  popups.update(dt)

  const at = levelAt(experience, curve)
  hud.set(experience, at.level, at.into, at.next)
  hud.setWins(wins)
  // The velocity Level grants, written into the **client's** live tuning — the object the controller reads.
  // It went into the descriptor's object for fifty levels and changed nothing: the client copies that on the
  // way in (ADR 0057, ADR 0071's correction).
  client.tuning.moveSpeed = maxSpeedMps(at.level, curve)

  sinceSave += dt
  if (sinceSave >= SAVE_EVERY) {
    sinceSave = 0
    saveExperience(experience)
    saveWins(wins)
  }
})

/**
 * The one folder this game adds (ADR 0075). Kodjo's list, nothing else: the two acceleration caps (ADR 0078), the
 * two resets and a grant. The curve, the keycap press feel and the popup feel have defaults and no sliders —
 * nobody asked for sliders.
 */
const loop = client.debugPane.addFolder({ title: 'Progression', expanded: false })
// The two movement numbers this game owns (ADR 0078): how hard a fast character may accelerate or turn, on the
// ground and in the air.
loop.addBinding(client.tuning, 'groundMaxAccel', { min: 5, max: 500, step: 1, label: 'ground accel m/s²' })
loop.addBinding(client.tuning, 'airMaxAccel', { min: 5, max: 500, step: 1, label: 'air accel m/s²' })
loop.addButton({ title: 'Reset experience' }).on('click', () => {
  experience = 0
  saveExperience(0)
})
loop.addButton({ title: 'Reset wins' }).on('click', () => {
  wins = 0
  saveWins(0)
})
// Jump ahead: type an amount, press the button. For reaching a level without walking there.
const grant = { amount: 1000 }
loop.addBinding(grant, 'amount', { min: 0, step: 1, label: 'grant XP' })
loop.addButton({ title: 'Add experience' }).on('click', () => {
  experience += Math.max(0, Math.floor(grant.amount))
  saveExperience(experience)
})
