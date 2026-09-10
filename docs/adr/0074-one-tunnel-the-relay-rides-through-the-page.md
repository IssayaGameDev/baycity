# ADR 0074 — One tunnel: the relay rides through the page

Status: accepted. `pnpm share [game]` opens one Cloudflare quick tunnel, to the game's dev server, which proxies
the relay at `/relay`. It takes the game as an argument, prints the link once cloudflared reports its connection
registered, and checks nothing else.

## Context

`pnpm share` existed for parkour only: port 5174 and `dev:parkour` were hardcoded. Kodjo wanted to send the
keyboard game to friends.

Making the game an argument was one table. What followed cost an hour and is the reason this ADR exists.

The first link printed did not work: Cloudflare answered `530` (error 1033, "tunnel not connected") for both
hostnames, for fifteen minutes, while cloudflared's own metrics showed the tunnels connected and zero requests
delivered. The real cause, found last: **a quick-tunnel hostname is seconds old when it is printed, and any
resolver asked about it before the edge knows it caches "does not exist" — for up to 30 minutes** (the zone's
negative TTL is 1800 s). Kodjo opened the link the moment it appeared; his machine's resolver, and the public
one behind it, cached the miss; the link was dead *on that machine* for as long as the tunnel lived.

Two wrong diagnoses along the way, recorded so they are not repeated:

- **"Two tunnels opened together are not routed."** It fit every observation for a while and was false. Every
  hand-opened tunnel — one or two, hand-run or spawned from Node exactly as the tool does — routed within 10 s
  and answered 200. The only tunnels that "never routed" were the ones a check had asked DNS about too early.
- **A readiness check.** Added so the tool would print the link only once the edge routed it, polling the
  hostname through Cloudflare's own resolvers. Its very first poll, two seconds after the hostname was born,
  planted the negative-cache entry at 1.1.1.1; every later poll for two minutes read it back as "no answer",
  and the tool declared a live tunnel dead. The check *was* the failure it reported.

## Decision

### One tunnel, and the relay is a path on the page's host

Each game's Vite dev server proxies `/relay` to the relay on `:9200`, WebSocket upgrades included, with the
prefix stripped. Colyseus's client accepts a pathname in its endpoint, so the page is handed
`?server=wss://<same host>/relay` and both its matchmaking HTTP calls and its room WebSocket go through the one
hostname. `createNetHost` already read `?server=`; nothing in the client changed.

Local play does not touch the proxy: with no `?server=` the client talks to `:9200` directly, as before.

The proxy is declared in every game's `vite.config.ts` rather than once, because that file is already each
game's own (port, `allowedHosts`) and there is no shared Vite config to put it in. Four identical blocks, with
the reason in each.

### The game is an argument

`pnpm share keyboard`. `SHARED_GAMES` in `tools/share/src/index.ts` is the table — name, root dev script, Vite
port — one line per game. No argument means parkour, which is what the command always did. A name that is not
a game stops before anything starts.

### Print the link, check nothing, say "wait 20 seconds"

The tool waits for cloudflared's `Registered tunnel connection` line — the one signal that costs no DNS query —
then prints the link with a note: give it 20 seconds before anyone opens it, because a name asked for too early
is cached as missing for half an hour on that machine.

No probe. There is no way to check a fresh hostname from outside without asking a resolver about it, and asking
is the harm. The user waiting is the check.

cloudflared's lines that matter — `Registered tunnel connection`, `ERR`, `WRN` — are forwarded. The old filter
kept only `ERR`.

## Consequences

- `pnpm share keyboard` prints the link within about ten seconds. Opened after the wait, it works.
- Quick-tunnel hostnames are random per run, so the link changes every session — and so does the **origin**,
  so anything a game keeps in `localStorage` (keyboard's XP and Wins) starts over with each link. Friends
  restart from zero each time Kodjo restarts the share.
- Traffic goes through Cloudflare's edge; feel is laggier than local, and game-feel or clock-sync numbers must
  not be read off it.
- 9 tests on the pure parts: hostname parsing, link composition, game selection, which cloudflared lines are
  news.

## Rejected

**Two tunnels.** The original shape. Worked; abandoned on a wrong diagnosis; not restored because one tunnel is
simpler and the `/relay` proxy is already in place. Kept as one.

**A readiness probe, any kind.** Tried twice — over HTTP with DNS through 1.1.1.1, and against the relay, which
speaks WebSocket and never answers a GET. Both were the failure they were meant to detect.

**A named Cloudflare tunnel or real hosting.** The durable answer for sharing with friends — stable link, saves
that persist, always on — and a hosting decision that is Kodjo's, not this tool's. Quick tunnels remain what
they were: debug-grade.

## Known open

- Saves reset per link. Real hosting fixes it; nothing else does.
- The share still needs Kodjo's PC on and the terminal open.
- Someone who opens the link too early is stuck for up to 30 minutes on that machine; `ipconfig /flushdns` (and
  the browser's own DNS cache) clears it, and the note on the link is the only guard.
