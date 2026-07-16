# games/

Game compositions built on top of `packages/`. Games may only **compose** the
stack — never modify `packages/` (SEED §6, law 3). Needing to change a package
for a game means there's a stack gap to fix.

A reference/sandbox game is deferred (SEED §1); milestones are exercised with
throwaway content instead.

Per-milestone throwaway demos live here; each supersedes the last (older ones are
recoverable at their milestone tag). Current:

- `physics-3d` — throwaway M3 demo: renders the server's Rapier3d world in Three.js
  via `@mp/render-three`, interpolated by `@mp/client`. Doubles as proof a game
  composes the stack without modifying it. Expected to be replaced, not kept.
  (M2's `walking-skeleton` was removed; recover it at tag `m2`.)
