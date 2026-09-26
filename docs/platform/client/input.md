# Input — keyboard, mouse, touch

| Layer | File | Role |
| --- | --- | --- |
| Types + pure key map | `packages/client/src/input.ts` | `InputState`, `InputSource`, `keysToMovement` |
| Touch rules (headless) | `packages/client/src/touchControls.ts` | `createTouchControls`, `TouchLayout`, zones |
| DOM binding | `packages/client/src/dom/keyboard.ts`, `dom/touch.ts`, `dom/index.ts` | events → the above |
| TPS host input | `packages/tps/src/inputs.ts` | `createInputs`: pointer lock, wheel, jump latch, actions, `worldMove` |
| Command | `packages/core/src/input.ts` | `InputCommand` |
| Action bindings | `packages/mode/src/actions.ts` | `ActionBindings`, `actionsHeld` |

## Shapes

```ts
interface InputState { x: number; z: number }          // each in [-1, 1]
interface InputSource { movement: () => InputState }
interface InputCommand { moveX: number; moveZ: number; jump: boolean; actions?: ReadonlySet<string> }  // moveX/Z world-space
type ActionBindings = Readonly<Record<string, readonly string[]>>   // action name → physical key codes
actionsHeld(bindings: ActionBindings | undefined, keys: ReadonlySet<string>): ReadonlySet<string>  // any code held → action held
```

`InputCommand.actions` is **held-this-tick**, not pressed (ADR 0061). Only `jump` has a press latch.

## Keyboard

Physical codes (`KeyboardEvent.code`) throughout — layout-independent.

```ts
keysToMovement(codes: ReadonlySet<string>): InputState
// x = (KeyD|ArrowRight ? 1 : 0) − (KeyA|ArrowLeft ? 1 : 0)
// z = (KeyS|ArrowDown ? 1 : 0) − (KeyW|ArrowUp ? 1 : 0)
```

`createKeyboardInput(target = window): KeyboardInput` — tracks `keydown/keyup` codes; `preventDefault` on `Arrow*`.

`createInputs` (tps) keeps its own `keys: Set<string>`; `preventDefault` on `Space` and `Arrow*`; `Space` with
`!e.repeat` sets the jump latch. Tick reads `jump = keys.has('Space') || touch.jump() || takeJump() || touch.drainJumpPress()`.

### Actions (`ModeDescriptor.actions` / `TpsClientOptions.actions`)

`Inputs.actions()` = `actionsHeld(bindings, keys)`; empty set when the game declared none (`@mp/mode`).

## Pointer lock (mouse) — `createInputs`

| Event | Rule |
| --- | --- |
| `canvas click` | `requestPointerLock()` if `!touch.active()` and not already locked |
| `canvas mousedown` button 0 | respawn if `isDead()` **and** locked (so the re-capture click after pause never cuts a death short) |
| `window mousemove` | only while locked → `camera.lookMouse(movementX, movementY)` |
| `window wheel` (`passive: false`) | only while locked → `preventDefault`, `camera.zoomNotch(sign(deltaY))` |
| `pointerlockchange` (shell) | lock held = pause closed; lost = pause open. Touch ignores this (ADR 0022). |

Never requested on touch (throws / no-ops on mobile). All listeners recorded for `dispose` (7 total).

## Touch — `createTouchControls(width, height, layout)`

Headless; consumes `(pointerId, x, y)` in CSS pixels of the target's rect (ADR 0022).

**Ownership rule**: a pointer belongs to the zone it first touched until released. Zones, tested in this order
(`zoneOf`):

| Zone | Test |
| --- | --- |
| `jump` | `hypot(x − (w − jumpInset.x), y − (h − jumpInset.y)) <= jumpRadius` (bottom-right) |
| `stick` | rectangle bottom-left: `x <= min(w·stickZone.width, stickZone.maxWidth)` and `y >= h − min(h·stickZone.height, stickZone.maxHeight)` |
| `null` | `y < topStrip` — pause button / debug pane strip, captures nothing |
| `look` | everywhere else |

- Stick: one pointer max; `anchor: 'recentre'` sets centre at touch point (un-clamped), `'fixed'` keeps home
  `(stickInset.x, h − stickInset.y)`. Knob clamped to ring for drawing; direction kept. `movement()` = deflection /
  `stickRadius`, circular dead zone on magnitude.
- Jump: `jump()` = held; `drainJumpPress()` = pressed since last drain (drain once per tick).
- Look: `dx/dy` accumulate; release with `travel <= tapSlop` sets `tapped`.
- Pinch: second `look` pointer starts one; `pinch += span − prevSpan`; **no look while pinching**; remaining finger
  re-baselined on release.
- `drainLook(): TouchLook { dx, dy, pinch, tapped }` — drained once per frame.
- `resize(w, h)` and `releaseAll()` clear all pointers and reset the stick.
- `active()` — true once any touch-type pointer seen; what decides whether the HUD is drawn.

### Pointer id rule

`stickId` / `jumpId` are `number | null`; **`null` is the sentinel, never `-1`**. iOS Safari reports negative
pointer ids, so a `>= 0` test read a real finger as none (comment in `touchControls.ts`).

### `TouchLayout` — `DEFAULT_TOUCH_LAYOUT`

| Field | Default | Meaning |
| --- | --- | --- |
| `stickRadius` | `64` | Ring radius px; full deflection |
| `stickInset` | `{ x: 110, y: 110 }` | Stick home from bottom-left (safe-area added by tps) |
| `stickZone` | `{ width: 0.45, height: 0.55, maxWidth: 380, maxHeight: 260 }` | Capture rect: viewport fractions, capped px |
| `jumpRadius` | `46` | Button radius px |
| `jumpInset` | `{ x: 84, y: 96 }` | From bottom-right |
| `topStrip` | `56` | Dead strip height px |
| `deadZone` | `0.12` | Fraction of radius, magnitude |
| `anchor` | `'recentre'` | `'recentre' \| 'fixed'` |
| `tapSlop` | `12` | Max travel px for a tap |

`createInputs` deep-copies the default and adds CSS `--safe-left/--safe-right/--safe-bottom` to the insets on
resize. The `touch` pane folder binds this live copy.

### DOM binding — `createTouchJoystick(target, layout?, { ignore? }): TouchInput`

- Listens on **`window`**, capture phase, `passive: false` (the Pixi overlay sits over the canvas; window sees all).
- `pointerType !== 'mouse'` counts as touch (pen, empty string included).
- Pointers starting inside an `ignore` element are neither routed nor suppressed. `preventDefault` only on
  pointers taken.
- `blur` → `releaseAll`; `resize` → `controls.resize(rect)`.
- Adds `setEnabled(on)` (off = release everything, route nothing; `active()` unaffected — used while pause open) and
  `dispose`.

`createBrowserInput(zone)` (`dom/index.ts`) — keyboard if any key held, else touch stick; exposes `touch`.

## `Inputs.worldMove(): { x: number; z: number }`

**Keyboard-first**: `keysToMovement(keys)` if non-zero, else `touch.movement()`. Rotated by `camera.yaw()` so the
result is **camera-relative world space**: `fwd = (−sin yaw, −cos yaw)`, `right = (−fwdZ, fwdX)`,
`out = fwd·(−rawZ) + right·rawX`, normalised if `|out| > 1`. Zero input → `{ x: 0, z: 0 }`. Facing is set from
this in the tick (`atan2(x, z)`).

## `Inputs` handle

```ts
interface Inputs {
  touch: TouchInput; layout: TouchLayout; keys: Set<string>
  takeJump: () => boolean; worldMove: () => { x: number; z: number }
  actions: () => ReadonlySet<string>; ignore: (el: HTMLElement) => void; dispose: () => void
}
createInputs({ canvas, camera: OrbitCamera, isDead, onRespawn, actions? }: InputsOptions): Inputs
```

`dispose` removes every listener, disposes touch, clears `keys`.

## Camera sensitivities (in `CameraParams`, `packages/camera/src/orbit.ts`)

`sensitivity = 0.0025` rad per mouse `movementX`; `touchSensitivity = 0.006` rad per CSS px; `pinchZoom = 0.02`
m per px. Pause slider maps `sensitivity` across `[0.0005, 0.006]`.
