# tools/

Dev and validation tooling.

- `netsim` — latency/jitter/loss `ClientTransport` wrapper. Not wired into the current
  client (ADR 0013).
- `bots` — headless `colyseus.js` load clients + the `load` harness (budgets 2 & 3);
  doubles as the live integration check.
- `viewer` — localhost content inspector (`pnpm dev:viewer`): picker, orbit,
  collider/marker/trigger overlays, jump-reachability gizmo, play-in-place (ADR 0014).
- `share` — opt-in remote debugging (`pnpm share`): puts the relay and the page behind
  two Cloudflare quick tunnels and prints one link. Latency is edge-relayed, so it is
  useless for game-feel or clock-sync measurement.
