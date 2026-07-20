# games/

Game compositions built on top of `packages/`. Games may only **compose** the
stack — never modify `packages/` (SEED §6, law 3). Needing to change a package
for a game means there's a stack gap to fix.

A reference/sandbox game is deferred (SEED §1); milestones are exercised with
throwaway content instead.

Per-milestone throwaway demos live here; each supersedes the last (older ones are
recoverable at their milestone tag). Current:

- `tps` — a 3D TPS character controller (orbit/mouselook camera, camera-relative movement,
  jump) on a static obstacle course. **Client-authoritative (ADR 0011):** each client
  simulates its own character (client-side Rapier) and reports its position; the server
  relays peers, which are interpolated. A **Tweakpane** "Network" folder tunes netsim
  latency/loss (affects how peers look) and camera feel. Composes
  `client`/`net`/`core`/`physics`/`render-three`/`netsim` + `@mp/server/tps` (shared sim).
  Run with `pnpm dev:server` + `pnpm dev:tps`. Doubles as proof a game composes the stack
  without modifying it.

The M2–M8 **ball demo** (`physics-3d`) was retired when the stack went client-authoritative
(it relied on server-side prop physics). Recover it at tag `m10`.
