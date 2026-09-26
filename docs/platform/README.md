# Platform docs

- Client-authoritative multiplayer web game platform (ADR 0011): each browser simulates its own player and reports state; a content-free Colyseus `GameRoom` relays peers on a clock-synced timeline (ADR 0013).
- Games are **modes** (`modes/*`): one `ModeDescriptor` + headless `rules.ts` each (ADR 0052), composing the shipped third-person humanoid game (`@mp/tps`, ADR 0065) over shared services (`@mp/game-client`).
- One shared stack: Rapier physics, Three.js + PixiJS rendering, data-driven levels of nodes with components (ADR 0035), assets by id (ADR 0026).
- Content is authored in the localhost editor (`tools/editor`, ADR 0023) and validated against the owning game's registry.
- Dependency direction: `modes/tools → packages`, never back; `core` imports nothing; simulation never imports rendering — the editor depending on games is the one deliberate sideways arrow.

## Docs

| File | Covers |
| --- | --- |
| `workspace.md` | package/game/tool list with deps and ports, dependency laws, scripts, adding a package or game, a game's own folder |
| `editor.md` | `tools/editor`: authored files, panels, files API routes, game discovery, live registry + adoption, prefab refusal, play-test, level validation test |
| `tooling.md` | `tools/share`, `tools/bots`, `tools/netsim` — commands, env, ports |
| `content.md` | level/prefab/asset data model, validation, loader |
| `components/api.md` | component declarations, hooks, runtime, registry |
| `components/built-ins.md` | engine, shared and player components with their params |
| `components/boss.md` | the `Boss` chaser: nodes, trigger rule, targeting |
| `mode.md` | `ModeDescriptor`, `ModeSession`, spawn, actions — the game contract |
| `netcode.md` | rooms, snapshot relay, wire format, interpolation, clock sync |
| `physics.md` | Rapier wrapper, bodies, character controller, triggers |
| `budgets.md` | performance budgets and measured numbers |
| `humanoid/controller.md` | capsule ground controller, tuning, locomotion component |
| `humanoid/gait.md` | procedural gait / animator |
| `humanoid/rig.md` | rig parts and pose |
| `client/services.md` | `@mp/game-client` services and `@mp/tps` composition |
| `client/tps.md` | the shipped third-person game client |
| `client/input.md` | keyboard/mouse/touch input and action bindings |
| `rendering.md` | Three stage, post-FX, materials, sky/sun, Pixi UI layer |
