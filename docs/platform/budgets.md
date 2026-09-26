# Budgets (SEED §5)

Tripwires, not targets. Exceeding one is never resolved silently — mitigation is Kodjo's call. Comfortably under needs no conversation.

| # | Budget | Target | How measured | Status |
|---|---|---|---|---|
| 1 | Client frame time | ~16 ms/frame (mid Android) | `stats.js` frame graph on the `@mp/tps` debug pane, off by default (ADR 0070, `packages/tps/src/pane.ts`); on-device by a human | tooling exists; no recorded on-device measurement |
| 2 | Downstream / client | ~20–30 kB/s | `tools/bots` load harness, relayed `NET_CHANNEL` payload bytes | measured 3.7 kB/s avg @ 20 bots on protocol v10 (commit `a24a173`, 2026-08-18); not re-measured since |
| 3 | Server tick time | < 33 ms/room | `getRoomStats()` (`packages/server/src/rooms.ts`) read by the load harness | measured avg 0.70 / max 1.48 ms @ 20 bots, same run; not re-measured since |
| 4 | Latency floor | 30–150 ms RTT + jitter | real-network playtests (human); `ClockSync.rttMs()` exists but is not surfaced on the pane | not measured; do not read numbers off a Cloudflare quick tunnel (ADR 0074) |
| 5 | Client memory | ~1–1.5 GB | on-device (human) | not measured |

## Load harness (budgets 2 & 3)

`pnpm --filter @mp/bots run load` → `tools/bots/src/load.ts`.

| Knob | Default | Source |
|---|---|---|
| `BOTS` | 20 | `load.ts` |
| `DURATION_MS` | 10000 | `load.ts` |
| `GAME` | `keyboard` | `bot.ts` (matchmaking filter) |
| `LEVEL` | `default` | `bot.ts` (matchmaking filter) |
| port | 9300 | `load.ts` |
| warm-up | 1500 ms before counting | `load.ts` |

- `startServer({ port })` in-process; each bot `joinOrCreate('game', { name: 'bot', game, level })` via `colyseus.js`, sends `encodeState` at 30 Hz walking a 5 m circle (`flags: STATE_GROUNDED`, real `yaw`, `speed = 0.12 × 5 × 30`, `base: 0`), counts `byteLength` of every `NET_CHANNEL` message received.
- Output: `budget 2 downstream/client avg/max kB/s` (÷1024), `budget 3 server tick avg/max ms` from `server.stats()`.
- `GAME`/`LEVEL` must match what a browser tab names or the bots land in their own room and nobody sees them (`tools/bots/src/matchmaking.test.ts`).

## Wire-cost arithmetic (from the codec, `packages/net/src/snapshot.ts`)

- Header 9 B + footer 2 B; 12 B per changed entity.
- Worst case, 20 clients all moving every tick: (19 × 12 + 11) B × 20 Hz = 239 B × 20 = 4.8 kB/s per client — payload only, Colyseus framing and WS/TCP excluded.
- Upstream `STATE` is 24 B × 30 Hz per client; not fanned out, not a tracked budget.
- Since the last measurement `PROTOCOL_VERSION` is still 10 and the entity layout is unchanged: ADR 0064's game bits reuse the existing flags byte, so byte cost is identical; delta frequency may differ (a game-state flip forces a relay) — not measured.

## Caveats on the recorded numbers

- Single process: bots and server share one event loop, so tick timings include contention.
- Payload bytes only (see above).
- Every bot moves every tick, so nothing is culled by the delta — worst case for budget 2.
- The recorded 3.7 kB/s and 0.70/1.48 ms are carried over from the last measured run; the harness has not been re-run for this document.

## Live-server testing

`tools/bots/src/matchmaking.test.ts` boots a real Colyseus server under vitest (project `live-server`, `pool: 'threads'` — `@pm2/io`'s `process.send` breaks the `forks` pool; `vitest.config.ts`). It asserts room separation by `level` and by `game`, not budgets.

## Not measured here

Budgets 1, 4, 5 are device/network-bound and human-owned. No automated capture exists for any of them.

## Named for the optimisation pass

Kodjo's call, recorded so a later pass has a starting list rather than a survey. Nothing here is a problem
today; all of it is frame cost that buys appearance.

| Candidate | What it costs | Note |
|---|---|---|
| GTAO (`createPostFX`) | a normal prepass, an AO pass and a Poisson denoise every frame, at full resolution | The heaviest single item. It is most of what gives greybox its form (ADR 0057), so cutting it is a look decision, not a free win. Its camera-kind define also has to be kept in step by hand (`rendering.md`) |
| Bloom (`UnrealBloomPass`) | a mip chain per frame | Cheap next to AO, and on by default per level |
| SMAA | one full-screen pass | The alternative is MSAA on the renderer, which the composer path does not get |
| Editor shadow casters | one extra scene render per caster, six for a point light | Already capped at `EDITOR_SHADOW_CAP = 4` (ADR 0047) |
| Hold boxes (editor) | one `BoxHelper.update()` per held node per frame | Only while somebody else has a selection |
