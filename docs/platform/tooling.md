# Tooling — `tools/*` (except the editor)

Editor: `editor.md`; its server: `editor-server.md`. All tools are `private`, source-first (`exports` → `./src/index.ts` where present), typechecked by `pnpm typecheck`.

## `tools/share` — `pnpm share [game]` (ADR 0074)

Opt-in remote debugging: one game's page behind **one** Cloudflare quick tunnel, the relay proxied through it, one link printed. No workspace deps; shells out to `cloudflared` (`winget install Cloudflare.cloudflared` on Windows).

| File | Contents |
| --- | --- |
| `src/index.ts` | pure helpers: `SHARED_GAMES`, `gameToShare`, `findTunnelUrl`, `isTunnelNews`, `composeShareLink` |
| `src/main.ts` | process orchestration (`tsx src/main.ts` via script `share`) |
| `src/index.test.ts` | tests for the helpers |

`SHARED_GAMES` (one line per game; a game not listed cannot be shared):

| name | script | port |
| --- | --- | --- |
| `parkour` (default) | `dev:parkour` | 5174 |
| `swing` | `dev:swing` | 5175 |
| `keyboard` | `dev:keyboard` | 5177 |

`gameToShare(argv)` — first non-`-` arg, default `parkour`; unknown name throws listing the valid ones.

Sequence (`main.ts`):
1. `assertCloudflared` — `cloudflared --version` must exit 0.
2. Probe `:9200` (relay) and the game's port on both `127.0.0.1` and `::1` (Vite binds `::1` only without `--host`). Running servers are reused; missing ones are spawned (`pnpm dev:server`, `pnpm <script>`), waited for up to `BOOT_TIMEOUT_MS = 60_000`.
3. `cloudflared tunnel --url http://localhost:<page port> --no-autoupdate`. Hostname from the banner (`findTunnelUrl`, timeout `TUNNEL_TIMEOUT_MS = 30_000`); link printed only after `Registered tunnel connection`.
4. Link: `composeShareLink(pageUrl)` = `<pageUrl>/?server=wss://<same host>/relay`. Read by `createNetHost` (`packages/game-client/src/netHost.ts`, `serverUrl()`); no `?server=` → `ws://<page host>:9200`.
5. Ctrl+C: `killTree` — `taskkill /pid <pid> /T /F` on win32 (plain `kill` orphans pnpm → node grandchildren), `SIGTERM` elsewhere.

Output filter: cloudflared lines pass only if `isTunnelNews` (`ERR|WRN|Registered tunnel connection|Unregistered`); the banner and pre-checks are dropped.

**No readiness probe, wait ~20 s before opening.** A resolver asked about the fresh hostname before the edge knows it caches NXDOMAIN for up to 30 min on that machine; a DNS-polling probe was itself the failure (ADR 0074).

Relay routing: each game's `vite.config.ts` has `proxy: { '/relay': { target: 'http://localhost:9200', ws: true, rewrite: strip '/relay' } }` and `allowedHosts: ['.trycloudflare.com']`. Quick-tunnel hostnames are random per run → new origin per session, so `localStorage` state (keyboard XP/Wins) resets. Edge-relayed latency: never read game-feel or clock-sync numbers off it.

## `tools/bots` — load harness

Headless `colyseus.js` clients for budgets 2 (downstream bandwidth/client) and 3 (server tick time); also the only live integration test.

| File | Contents |
| --- | --- |
| `src/bot.ts` | `createBot(url, phase)` → `Bot { bytesReceived, messages, close }` |
| `src/load.ts` | the harness (script `load`: `tsx src/load.ts`) |
| `src/matchmaking.test.ts` | boots a real server (`startServer({ port: 9317 })`) — asserts `filterBy(['game','level'])` separates rooms by level and by game, and that an omitted `level` is a wildcard |
| `src/index.ts` | re-exports `createBot`, `Bot` |

Bot behaviour: `joinOrCreate('game', { name: 'bot', game: GAME, level: LEVEL })`; every tick (`TICK_HZ = 30`) sends `encodeState` on `NET_CHANNEL` walking a circle (`RADIUS = 5`) with `STATE_GROUNDED`, a tangent yaw and a real speed so deltas are non-trivial; counts relayed bytes/messages (payload only, Colyseus framing excluded). Join failures are ignored.

Run:

```sh
pnpm --filter @mp/bots run load                       # 20 bots, 10 s
BOTS=30 DURATION_MS=15000 pnpm --filter @mp/bots run load
GAME=keyboard LEVEL=keyboard pnpm --filter @mp/bots run load
```

| Env | Default | Meaning |
| --- | --- | --- |
| `BOTS` | `20` | bot count |
| `DURATION_MS` | `10000` | measurement window (after a fixed 1.5 s matchmaking settle) |
| `GAME` | `parkour` | matchmaking filter |
| `LEVEL` | `default` | matchmaking filter — must match what a browser tab names or bots land in their own room |

Starts its own server on `PORT = 9300`, in-process (server + bots share one event loop → tick timings include contention; ballpark, not a benchmark). Prints `budget 2 downstream/client avg/max kB/s (target ~20–30)` and `budget 3 server tick avg/max ms (target < 33)`, then exits. Live-server test runs in the vitest `live-server` project with `pool: 'threads'` (see `vitest.config.ts` for why forks break `@pm2/io`).

## `tools/netsim` — network-condition transport wrapper

`createNetsimClientTransport(inner: ClientTransport, initial: NetsimConditions, rng = Math.random): NetsimClientTransport` (`src/index.ts`). Delays and drops messages in **both** directions with `setTimeout`.

| `NetsimConditions` | Meaning |
| --- | --- |
| `latencyMs` | one-way base latency per direction (RTT ≈ 2×) |
| `jitterMs` | uniform ± added per message |
| `lossRate` | drop probability [0..1] |

Extra methods: `setConditions`, `conditions`. Headless (→ `@mp/core` only). Tested with fake timers in `src/index.test.ts`. **Not wired into any client** — no import outside `tools/netsim` (ADR 0013). No run script.

## `tools/viewer` — content viewer

`pnpm dev:viewer` → `http://localhost:5175`. **Port clash:** `modes/swing/vite.config.ts` also binds 5175; they cannot run together.

| File | Contents |
| --- | --- |
| `src/registry.ts` | `ENTRIES`: hand-written catalog, currently one entry — `level1` validated against `PARKOUR_MODE.registry`, `mode: PARKOUR_MODE`; `CLIP_SOURCE` from globbed `content/assets/**/*.anim.json` + `.meta` |
| `src/main.ts` | Three stage + greybox environment + post-FX (renderer defaults), `OrbitControls`, Tweakpane panel |

Panel (`Pane`, title "Content viewer"):
- **Content** → entry picker.
- **Overlays** → `grid`, `colliders (x-ray)` (edge outlines of every collider), `markers/triggers` (spawn + one gizmo per gameplay component coloured by `mode.gizmos`), `jump reach` (ring + arc from `tuning.jumpHeight`/`gravity`/`moveSpeed`).
- **Play-in-place** → `play (WASD+Space)`: `addCharacter` + `stepCharacter` on a fixed loop, camera-relative move, no networking, no rules session.

Deps: `@mode/parkour`, `@mp/humanoid`, `@mp/components`, `@mp/content`, `@mp/core`, `@mp/mode`, `@mp/physics`, `@mp/render-three`, `tweakpane`. Greyboxes everything (no asset runtime).
