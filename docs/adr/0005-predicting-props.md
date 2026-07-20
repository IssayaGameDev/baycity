# ADR 0005 — Predicting props (pull into the prediction loop)

Status: accepted (M4). Extends ADR-0004. **Superseded by ADR 0011** (client-authoritative):
there is no prediction loop to pull props into. Shared-prop ownership is now ADR 0011's D1=B
policy (per-client ownership + handoff), not yet built. Retained for history.

## Context

With props (balls) server-authoritative and not predicted, pushing one felt
"heavy": the local player stalled against the ball until the server resolved the
push and it propagated back (RTT + interpolation delay). SEED §4 anticipates this —
"the stack must support pulling a contacted body into the prediction loop; games
decide when" — and Kodjo (design) decided the balls need instant response.

## Decision

- **Generalise the client predictor** from player-only to a **world predictor** over
  a `PredictedWorld` (apply input + step; read/restore a set of predicted entities).
  Player and props are handled uniformly: per-entity render-interpolation + a
  decaying correction offset.
- **Predict the balls** locally (dynamic in the client world) so pushing is instant.
  Remote players stay non-predicted (unknown input) — kinematic obstacles synced
  from snapshots.
- **Full-state reconciliation:** restore all predicted entities to the authoritative
  snapshot positions, then replay unacked local inputs (re-simulating the local
  world). **Position-only** (no velocities on the wire) as v1; balls are damped so
  free-coasting velocity loss is negligible.
- **Demo content:** balls are inert, damped, pushable — dropped the falling/re-drop
  ambiance, since predicting server-timed re-drops would fight the client sim.

## Consequences / per-game cost

- Low marginal cost: a game writes its sim once (needed for the server anyway) and
  exposes read/restore of predicted entities; the predictor/reconciliation is
  generic. The game only decides *which* entities are predicted (the SEED design knob).
- Position-only reconciliation is approximate for fast free-moving props; exact
  reconciliation would add prop velocities to the wire (fits M6 quantization).
- Cross-platform float drift is corrected by reconciliation (already the model).

## Rejected

- **Kinematic-obstacle-only** (the first attempt): stopped pass-through but the player
  stalled and pushes felt heavy — rejected by Kodjo.
- **No player↔prop collision / pass-through** — rejected: interaction must be realistic
  and multi-player.
- **Velocities on the wire now** — deferred to M6 (quantization); damping makes
  position-only acceptable for v1.
