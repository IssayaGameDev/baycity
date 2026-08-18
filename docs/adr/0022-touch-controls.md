# ADR 0022 — Touch controls: stick bottom-left, jump bottom-right, look everywhere else

Status: accepted. Kodjo's layout and his calls on each behaviour, recorded before implementation.

## Context

Mid-range Android and iOS Safari were named first-class targets in the original requirements, and the
stack has never been playable on either. Groundwork existed and was imported by nothing: a floating
`createTouchJoystick`, a `createBrowserInput` that merged it with the keyboard, and a joystick view in
`render-pixi/hud.ts`. `modes/parkour` read `keydown`/`keyup` for movement, Space for jump, and
**pointer lock** for the camera — and pointer lock does not exist on mobile browsers at all. A phone
could open the Pixi pause screen and nothing else.

## Decisions

**Layout (Kodjo's).** Movement stick bottom-left, jump button bottom-right, and the whole rest of the
screen is look control. The same arrangement Roblox mobile uses.

**Stack-wide, not a parkour pass** (Kodjo's call). The controls live in `@mp/client` (routing + stick
maths, headless) and `@mp/render-pixi` (the view); the mode only wires them. That makes this layout *the
stack's* layout, which every later mode inherits.

**The stick is a hybrid: fixed home, re-centring on capture.** The ring is always drawn at its
bottom-left home so the control is discoverable, but any pointer starting anywhere in the bottom-left
zone captures it, and on capture the stick's centre moves to the touch point and deflection starts at
zero.

The deciding case is a mid-air re-grip. With a fixed centre — Roblox's behaviour — the deflection on
touch-down is `(touch − home) / radius`, so a thumb landing 150 px from the home is at **full deflection
instantly**, in whatever direction it happened to land. Deliberate touches are fine; a re-grip mid-jump
bolts the character sideways and loses the run. Re-centring has no equivalent failure, and what it costs
is absolute muscle memory, which a parkour game barely uses — you hold a direction and jump.

Kept as a switch (`anchor: 'recentre' | 'fixed'`, default `recentre`) because a minute on real hardware
settles it better than argument, and it is one branch either way.

**Stick maths.** `movement = (touch − centre) / radius`, clamped to length 1 with direction preserved, so
pushing past the ring keeps steering at full strength rather than cutting out. A small dead-zone fraction
(Kodjo's call) keeps a resting thumb from creeping. On capture the centre is clamped so the whole ring
stays inside the zone — otherwise a touch near the screen edge has a squashed range on one side. Output
is `{ x, z }` in −1..1, the same shape `keysToMovement` produces, so it goes through the mode's existing
`worldMove()` and is camera-relative for free.

**Jump is hold-capable** (Kodjo's call), which inherits desktop behaviour exactly: `stepCharacter` reads
`cmd.jump && state.grounded` every tick, level-triggered, so a held button re-jumps the instant you land
— the same hop-on-landing that holding Space already gives.

**Pointer ownership is by `pointerId`, decided at first contact.** Whichever zone a pointer starts in
owns it until release; nothing can steal it. That is what lets the stick, the look drag and the jump
button work at the same time, and it is also what stops a left thumb on the stick pairing with a right
thumb into an accidental pinch.

**Look is the rest of the screen, minus the control zones and a top strip** reserved for the pause button
and the debug pane. Drag accumulates yaw/pitch deltas which the mode consumes and applies exactly as it
applies `movementX`/`movementY` today — but with **its own sensitivity**, because a finger crossing a
phone is nothing like a mouse delta.

**Respawn while dead is a tap in the look region** (Kodjo's call), matching desktop's left click. A tap
is a release whose total travel stayed under a threshold — measured in distance, not time, so the core
needs no clock. Explicitly a placeholder until the dev menu with its own respawn button exists.

**Pinch to zoom, wired last.** Two pointers *both* owned by the look region drive `camZoom` between the
existing min and max; look is suspended while they are down. Traps, all handled rather than discovered:

- On dropping back to one pointer the remaining pointer must be **re-baselined**, or the camera snaps by
  the distance between the two fingers.
- The browser wants the gesture. `touch-action: none` plus `preventDefault` is what carries it; iOS has
  ignored `user-scalable=no` since iOS 10, and double-tap zoom needs suppressing separately.
- A pinch needs both pointers to have started in the look region, which falls out of the ownership rule.
- A pinch is ~300 px of travel for the whole 3–14 m range, so it gets its own sensitivity;
  `camZoomSmooth` already damps the rest.

**Touch mode is detected from events, not capabilities.** Controls appear on the first `touch`-type
pointer event and disappear on the first mouse event. `navigator.maxTouchPoints > 0` at load is wrong on
touch laptops and on an iPad with a trackpad; watching what the player actually uses is right on both.

**The debug pane stays on phones** (Kodjo's call) — it is a dev tool for now, and the top strip keeps the
look region from fighting it.

**Pause stops depending on pointer lock.** Today `pointerlockchange` both opens and closes the menu.
With no lock on touch, the pause button drives it and `resumePlay()` must not request one.

## Consequences

- The bottom-left zone belongs to the stick, so you cannot look by dragging there. Two-handed that is
  what players do anyway; one-handed loses look on that side. The zone is a knob (fractions of width and
  height) so it can be shrunk.
- Every feel number is exposed for tuning on the device, as the gait and camera ones are: stick radius
  and inset, dead-zone fraction, zone size, jump button size and inset, look sensitivity, pinch
  sensitivity.
- The routing core is pure — it consumes `(pointerId, x, y)` and emits state — so ownership, zones,
  clamping, dead zone, tap detection and pinch re-baselining are all unit-tested headlessly. Only the
  event binding needs a browser.
- `createTouchJoystick` is replaced rather than kept alongside: it was floating-only, mapped
  screen-down to +z for a top-down demo that no longer exists, and had no tests. `render-pixi/hud.ts` —
  the second Pixi application from the retired ball demo, whose joystick view this supersedes — is
  deleted along with it.
- Nothing about this touches the wire, the sim, or the animation. It is an input adapter and a view.

## Rejected

**Fixed-centre stick** (Roblox's exact behaviour). See above — the mid-air re-grip case. Available behind
the switch.

**Floating stick with no drawn home.** Forgiving, and invisible until touched, so a new player has no
idea it exists.

**Tap-to-jump only.** Would need an edge filter over a level-triggered controller, and would throw away
hop-on-landing that desktop already has.

**`maxTouchPoints` for detection.** Wrong on hybrid devices in both directions.

**Reusing `createHud`.** It is a second Pixi application from the retired ball demo; the mode already has
one overlay (ADR 0015) and the controls belong on it.
