# games/

Game compositions built on top of `packages/`. Games may only **compose** the
stack — never modify `packages/` (SEED §6, law 3). Needing to change a package
for a game means there's a stack gap to fix.

A reference/sandbox game is deferred (SEED §1); milestones are exercised with
throwaway content instead.

- `walking-skeleton` — throwaway M2 demo (Vite + canvas): connects to `@mp/server`,
  interpolates one sphere via `@mp/client`. Doubles as proof a game composes the
  stack without modifying it. Expected to be replaced, not kept.
