# ADR 0011 — Client-authoritative netcode (reverses SEED §4)

Status: accepted. Supersedes the server-authoritative model of ADR 0004 (prediction/
reconciliation) and ADR 0005 (predicted props), and the lag-compensation half of ADR
0006 (clock sync is retained). Reverses the SEED §4 lock with Kodjo's sign-off.

## Context

SEED §4 locked a server-authoritative model: clients send inputs, the server owns all
state, clients predict + reconcile, hits are lag-compensated via rewind. That fits
competitive physics/shooter games. Kodjo re-scoped the target game class: player-to-player
interaction is scarce, cheating is tolerated, and rewind/lag-comp is not needed. For that
class, server authority only adds cost — its guarantees (anti-cheat, contested-object
coherence, hit validation) are the things being given up by design. Client authority is
more reactive (the whole local world responds at 0 ms, not just a predicted subset) and
sheds the server physics step. See the discussion that led here and PLAN-client-auth.md.

## Decision

- **Client owns its own entity.** Each client runs the sim locally (authoritative for its
  own body) and sends its resulting position as `STATE`. No server correction → no
  reconciliation, no unacked queue, no eased offsets. `@mp/client` replaces the predictor
  with `createLocalController` (local sim + render-interpolation only).
- **Server is a pure relay.** It owns no simulation and runs no physics. It assigns ids,
  stores each client's last reported position, relays *peers'* positions as per-client
  delta snapshots on its own clock-synced timeline (a client is never sent its own body),
  and answers clock-sync pings. `createRoom()` takes no `GameSim`.
- **Protocol v6.** Add `STATE` (c→s, full-float position). Remove `INPUT`, `FIRE`, `HIT`
  and the snapshot's `lastProcessedInputSeq` (nothing to acknowledge). Clock sync
  (`PING`/`PONG`) is retained — it now drives only peer interpolation.
- **Ownership policy for shared/unowned objects (D1 = B):** when a game later has shared
  dynamic props, each is owned by one client that simulates and relays it, with
  handoff-on-contact, server-refereed claim arbitration, and reassignment on owner
  disconnect. **Not built** — the TPS demo has no shared props. Recorded as the policy.
- **Exercise = TPS (D2).** Each client owns its character; the obstacle course is static
  (no authority needed). The M2–M8 **ball demo is retired** (it needed server prop
  physics); recoverable at tag `m10`. `startServer` is single-mode.

## Consequences

- Server tick sheds the physics step: budget 3 fell to avg 0.33 ms / max 1.07 ms @ 20 bots
  (was 0.47 / 9.54); budget 2 to 2.8 kB/s (self excluded from snapshots + lighter header).
  Upstream grows slightly (14 B state vs 9 B input) — not a measured budget.
- Peer positions now originate at the peer, so they arrive ~one extra network leg late
  (client→server→client) vs server-auth (server→client). Inherent to relaying.
- Contested objects would diverge/snap on handoff (accepted: interactions are scarce).
- `@mp/server/tps` still houses the shared sim, now run only by clients + bots — a
  historical wart (ADR 0010); relocating it out of `@mp/server` is future cleanup.

## Rejected

- **Keep server-authoritative** — its guarantees are unused by this game class; pure cost.
- **Hybrid: server owns props, clients own players (D1 = A)** — reintroduces prop latency
  or the reconciliation machinery being retired; only wins for coherent shared props,
  which the target class doesn't need.
- **Dual-mode server (authoritative + relay)** — doubles the server surface; contradicts
  the switch.
