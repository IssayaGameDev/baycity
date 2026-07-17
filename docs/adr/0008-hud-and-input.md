# ADR 0008 — HUD (PixiJS) and input abstraction

Status: accepted (M7)

## Context

SEED §2/§3/§7: a PixiJS 2D HUD stacked over the Three.js canvas, and one input
abstraction behind keyboard/mouse and touch from day one (bots use a synthetic source).

## Decision

- **HUD = a separate PixiJS canvas** (`@mp/render-pixi`, `backgroundAlpha: 0`) stacked
  over the Three canvas (`pointer-events: none`) — a separate context, not shared GL
  (SEED §2). Pixi's ticker renders it; callers push state (status text, crosshair,
  joystick) via setters.
- **Input abstraction** — the interface, the pure key→movement mapping, and a manual
  source are headless (`@mp/client`); DOM adapters (keyboard, virtual-joystick touch)
  live in **`@mp/client/dom`**, a subpath compiled with a second, DOM-enabled tsconfig.
  This keeps the main `@mp/client` headless (bots) while the stack still ships the
  adapters (SEED §6 places input under client).
- **Touch = virtual joystick** over a zone element (pointer events → normalised movement
  + a view state the HUD draws). Keyboard + touch merge into one `InputSource`
  (`createBrowserInput`); the game consumes only the interface.
- **Firing** stays a pointer/click on the game canvas (mouse or touch tap); the HUD
  canvas is pointer-transparent so clicks reach the game, and the joystick zone captures
  its own pointers.

## Consequences / per-game cost

- A game gets kb/m + touch via `createBrowserInput(zone)` + `movement()`; bots use
  `createManualInputSource`. HUD is `createHud()` + setters.
- The client `./dom` subpath needs its own tsconfig (documented in workspace.md).
- ES2022 build target (top-level await for the async HUD init) — within the SEED
  mobile-Safari reach.

## Rejected

- **DOM lib on all of `@mp/client`** — would drop the headless-type guard on the netcode.
- **A separate input package** — a layout change (ask-first); the client subpath keeps
  input under client per SEED §6.
- **Shared GL context for the HUD** — SEED §2 mandates a stacked canvas.
