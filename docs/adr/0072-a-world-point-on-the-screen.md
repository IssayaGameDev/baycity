# ADR 0072 — A world point on the screen, and a `+1` that leaves the key

Status: accepted. `TpsClient.toScreen` projects a world point to overlay pixels; `modes/keyboard` floats a `+1`
off every key the local player strikes.

## Context

ADR 0071 put the XP counter at the bottom of the screen, which means the reward for stepping on a key is
somewhere other than where the player is looking. In this genre the counter moving **is** the reward, so a
counter you have to glance away to read is the wrong place for it.

The fix is a label that leaves the key you actually hit. That needed something the platform did not have: a way
to turn a world position into a screen one. `OrbitCamera` wraps the `PerspectiveCamera` and does not expose it,
so a game had no route to a projection at all.

## Decision

### `toScreen`, not the camera

`toScreen(world) => { x, y } | null`, in **overlay pixels**.

A helper rather than handing over the `PerspectiveCamera`, because every game pinning anything to anything
would otherwise redo the same three steps, and the last two are easy to get wrong:

1. Project through the camera.
2. Map clip space to the **overlay's** pixels — not the window's, which differ on mobile, where the canvas is
   `dvh`-sized and shorter than the layout viewport (ADR 0022's own reason for reading the canvas rect).
3. Reject points behind the lens. `project` divides by `w`, which is negative back there, so a point behind the
   camera comes back **mirrored into view** rather than absent — a label at a plausible-looking position for a
   thing that is not on screen.

General rather than feature-shaped: nameplates, damage numbers, waypoints and this game's popups all want the
same answer. It is the same "hand over a fact, teach the platform nothing" move as ADR 0066.

### The popup is screen space, captured once at spawn

Projected from the struck cap's **top** on the frame it goes down, then animated purely in overlay pixels.

Re-projecting every frame was the obvious alternative and is worse twice over: a swaying label fighting the
camera's own motion jitters, and it costs a projection per label per frame. Nobody reads a number that is trying
to stay glued to a moving key.

The cap's top rather than its base, because a label born inside the board is born clipped.

### The feel, and why each part

- **Punch in at 1.45× and settle** over the first tenth of the life. Without it a label fades in, which reads
  as appearing rather than as being struck.
- **Rise on an eased curve** — quick off the key, slowing as it goes. Thrown, not dragged.
- **Sway**, with a random phase per label, so two born on the same frame do not move as one body.
- **Opaque for the first third, then out.** Fading from frame one makes the number hardest to read at exactly
  the moment it appears.

### Pooled, and the oldest is what gets recycled

48 labels, allocated once. A pool because a running player strikes a few keys a second and Pixi text costs a
texture per change. Past the ceiling the **longest-lived** label is taken, which is the right one to lose: a
label already fading is the one nobody is reading.

### `hold` answers both questions at once

`Keycaps.hold` returned a count and now returns the struck caps' positions. The count is ADR 0071's "+1 per
key" and the positions are where its popup comes from, so one call serves both rather than the caller looking
the same caps up a second time.

## Consequences

- Stepping on a key throws a `+1` off it. Only the local player's — every character's keys press down, one
  player's are paid for and popped for.
- Six sliders: life, rise, sway, sway cycles, spawn scale, opaque-for.
- `@mp/render-pixi` re-exports `Container` alongside `Graphics` (ADR 0071), so the game builds its own layer
  without a second Pixi.

## Rejected

**Exposing the `PerspectiveCamera`.** Every consumer would redo the overlay-pixel mapping and the
behind-the-lens rejection, and getting either wrong is subtle rather than obvious.

**3D text in the scene.** Would need a mesh per popup, would be occluded by the very keys it came from, and
would scale with distance — the opposite of a HUD.

**Re-projecting per frame.** Jitter, and a projection per label per frame.

**One shared label showing a running total.** That is the HUD counter, which is the thing this exists to
complement.

## Known open

- **No click.** Still the biggest missing piece of the feedback, and still a whole audio system.
- The popup shows `+perKey`, so it will not read multipliers until there are any.
- Nothing pools across games; each game that wants popups writes its own, which is correct until a second one
  does.
