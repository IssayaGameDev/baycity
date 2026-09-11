# ADR 0085 — A staging game on the box

Status: accepted. `dev.playgorbo.com` is the keyboard game's **Vite dev server** running on the editor box,
with the relay beside it, behind the same tunnel and the same Access policy as the editor. It bundles the
box's `content/` — the folder the hosted editor writes — so a save is playable by everyone a second later.

## Context

The content people could edit (ADR 0083) but not play. The editor's Play button runs the rules in the editor
with no HUD, no progression and nobody else in the level. The real game ran only from a clone with `pnpm
dev:keyboard`, which is the install they must never need.

## Decision

- **The dev server, not a build.** A build freezes content at build time; the dev server reloads on every file
  change, and the files it watches are the ones the editor writes. For three people that is the right tool.
- **Same box, same tunnel, same login.** One more public hostname routed to `localhost:5177`, added as a
  destination of the `Editor` Access application, so the `Team` policy covers it. `playgorbo.com` stays for
  the release, built from master.
- **The relay rides the page's origin.** `relayUrl()` (`packages/game-client/src/relayUrl.ts`): `?server=`
  wins; an `http:` page talks to `:9200` directly (the dev machine); an `https:` page uses `wss://<host>/relay`,
  which every game's Vite config already proxies to the relay (ADR 0074). No `?server=` to hand out.
- Keyboard only for now (Kodjo). Another game is another unit file and hostname.

## Rejected

- Rebuild the game on every content change. Seconds of CPU per save on a small box, for what HMR does free.
- A separate Access application. Two policies to keep in step for the same three people.

## Consequences

- Two more systemd units, `mp-relay` and `mp-game-keyboard`, installed by `setup.sh`, restarted by `update.sh`.
- `allowedHosts` gains `.playgorbo.com` in every game's Vite config.
- `CONTRIBUTING.md` tells the content people to play at `dev.playgorbo.com`.
