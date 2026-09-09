import { CHAR_RADIUS, LIMB_LENGTH } from '@mp/humanoid'
import { THREE } from '@mp/render-three'
import { startTpsClient } from '@mp/tps'

import { KEYBOARD_MODE } from './editorMode'
import { DEFAULT_KEYCAP_SHAPE, type KeycapShape } from './keycapGeometry'
import { DEFAULT_KEYCAP_LOOK, DEFAULT_PRESS, drawKeycaps, type KeycapLook, type PressFeel } from './keycaps'

/**
 * Keyboard Escape, as an application (ADR 0069).
 *
 * The shipped third-person game plus two things it knows nothing about: platforms carrying a `Keyboard`
 * component get their top face tiled with keycaps, and every cap somebody is standing over is **held down**
 * until they move off it.
 *
 * Occupancy, not footfalls. A key that bobbed once per step popped back up under a standing player, which is
 * not what a keyboard does — you leave a print of your feet in it.
 *
 * Both go through what ADR 0066 opened: the scene to draw into, a per-frame hook, and the drawn rig parts.
 * The last is why **other players press keys too** — their animator runs on this machine (ADR 0063), so where
 * their feet are is known here with nothing on the wire.
 *
 * **Still not the game.** No speed number, no click, no Wins. The press is the feedback those hang off.
 */
const look: KeycapLook = { ...DEFAULT_KEYCAP_LOOK }
const shape: KeycapShape = { ...DEFAULT_KEYCAP_SHAPE }
const feel: PressFeel = { ...DEFAULT_PRESS }

const client = await startTpsClient(KEYBOARD_MODE)
const keycaps = drawKeycaps(client, look, shape, feel)

/**
 * Where a character's weight is: under the body, at the height of the lower **sole**.
 *
 * The sole and not the part's origin. `partsOf` gives each part's centre, and a lower leg is 0.375 m long, so
 * its centre sits ~0.19 m above the foot — enough that a band tight enough to reject a falling player would
 * also reject one standing still.
 *
 * Taken from the **drawn** parts rather than from the simulation, so it is one source for us and for every
 * peer, and it follows the rig you can see rather than the capsule you cannot.
 */
const soleY = (part: { position: { y: number }; rotation: { x: number; y: number; z: number; w: number } }): number => {
  const down = new THREE.Vector3(0, -LIMB_LENGTH / 2, 0)
  down.applyQuaternion(new THREE.Quaternion(part.rotation.x, part.rotation.y, part.rotation.z, part.rotation.w))
  return part.position.y + down.y
}

const standing = (parts: NonNullable<ReturnType<typeof client.partsOf>>): { x: number; y: number; z: number } => ({
  x: parts.body.position.x,
  y: Math.min(soleY(parts.lowerLegL), soleY(parts.lowerLegR)),
  z: parts.body.position.z,
})

client.onFrame((dt) => {
  const me = client.id()
  if (me !== null) {
    const parts = client.partsOf(me)
    if (parts !== null) keycaps.hold(standing(parts), CHAR_RADIUS)
  }
  for (const peer of client.peers()) {
    const parts = client.partsOf(peer.id)
    if (parts !== null) keycaps.hold(standing(parts), CHAR_RADIUS)
  }
  // After every hold, which is the order the caps' own doc requires.
  keycaps.update(dt)
})

const folder = client.debugPane.addFolder({ title: 'Keycaps', expanded: false })
folder.addBinding(feel, 'depth', { min: 0, max: 1, step: 0.01, label: 'press depth' })
folder.addBinding(feel, 'downTime', { min: 0.01, max: 0.4, step: 0.005, label: 'down s' })
folder.addBinding(feel, 'upTime', { min: 0.01, max: 0.6, step: 0.005, label: 'up s' })
