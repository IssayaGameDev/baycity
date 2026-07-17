# games/

Game compositions built on top of `packages/`. Games may only **compose** the
stack — never modify `packages/` (SEED §6, law 3). Needing to change a package
for a game means there's a stack gap to fix.

A reference/sandbox game is deferred (SEED §1); milestones are exercised with
throwaway content instead.

Per-milestone throwaway demos live here; each supersedes the last (older ones are
recoverable at their milestone tag). Current:

- `physics-3d` — throwaway demo, evolving per milestone. **Currently M4:** a
  WASD-controlled, client-predicted player (client-side Rapier, reconciled against
  the server) among interpolated server balls, with netsim sliders and a prediction
  toggle, plus a **PixiJS HUD** (crosshair/status) and **keyboard + touch-joystick**
  input via `@mp/client/dom`. Composes `client`/`net`/`core`/`physics`/`render-three`/
  `render-pixi`/`netsim` + `@mp/server/sim`. A **Tweakpane** "Network" folder exposes the
  netsim knobs and the two game-feel sliders live. Doubles as proof a game composes the
  stack without modifying it. (M2's `walking-skeleton` was removed; recover it at tag `m2`.)
- `tps` — M10 prototype: a 3D TPS character controller (orbit/mouselook camera,
  camera-relative predicted movement, jump) on an obstacle course. Runs against the server
  in `tps` mode (`pnpm dev:server:tps`). The first game that made the server host a
  pluggable `GameSim` (ADR-0010).
