# Humanoid ground controller (`@mp/humanoid`)

`packages/humanoid/src/groundController.ts`. One kinematic-capsule controller: fixed-apex jump, time-based ground accel/brake, force-limited air control, riding moving surfaces (ADR 0012). Client-authoritative, run by each client for its own body (ADR 0011). Reached by a game through `createLocomotion` (ADR 0061); not "the" platform controller (ADR 0062).

## Constants

| Symbol | Value | Meaning |
|---|---|---|
| `CHAR_RADIUS` | 0.4 m | capsule radius |
| `CHAR_HALF_HEIGHT` | 0.6 m | capsule cylinder half-height; total height `2·(0.6+0.4)` = 2.0 m, width 0.8 m |

Tick constants live in `@mp/core` (`TICK_RATE_HZ` 30, `TICK_DT`), not here.

## `CharacterTuning`

`DEFAULT_TUNING` values. Arc-shaping fields each have an inert value so any one can be switched off alone.

| Field | Unit | Default | Meaning |
|---|---|---|---|
| `moveSpeed` | m/s | 5.5 | target ground speed |
| `jumpHeight` | m | 2.7 | apex above launch; take-off `vy = √(2·gravity·jumpHeight)` (17.2 m/s) |
| `gravity` | m/s² | 55 | downward magnitude |
| `groundAccelTime` | s | 0.1 | rest → full speed; rate = `moveSpeed / groundAccelTime` |
| `groundStopTime` | s | 0.08 | full speed → stop on released input |
| `groundMaxAccel` | m/s² | `Infinity` | ceiling on **gaining** ground speed (ADR 0078/0096) |
| `groundBrakeMaxAccel` | m/s² | `Infinity` | ceiling on **losing or redirecting** it: a release, and every turn |
| `airMaxAccel` | m/s² | `Infinity` | ceiling on air steering |
| `maxAccelScaling` | exponent | 0.5 | how the three ceilings grow with speed: `0` fixed, `0.5` with `√v`, `1` constant time. `Infinity` ceilings ignore it |
| `ACCEL_REF_SPEED` | m/s | 15 (const) | the speed a ceiling is quoted at: `ceiling(v) = ceiling × (v/15) ** maxAccelScaling` |
| `airControl` | 0..1 | 1 | air rate = ground accel × this |
| `maxFallSpeed` | m/s | 60 | terminal velocity; clamps falling only, never a jump/launch |
| `coyoteTime` | s | 0.1 | jump still fires this long after losing footing; 0 = off |
| `jumpBufferTime` | s | 0.1 | press held pending this long; fires on landing; 0 = off |
| `liftStoreTime` | s | 0.1 | departed mover's velocity offered to a late (coyote) jump; 0 = off |
| `fallGravityScale` | × | 1.6 | gravity while `vy < 0` and not in apex window; 1 = symmetric |
| `apexGravityScale` | × | 0.5 | gravity while `|vy| < apexSpeed`; 1 = off |
| `apexSpeed` | m/s | 4 | width of the apex window |
| `jumpCutScale` | × | 1 | `vy` multiplier when jump released mid-rise; 1 = off, 0 = hard stop |

Gravity scale is chosen from `vy` at tick start, only when airborne (`under === undefined || leaving`); a resting character never sees the apex scale.

## `CharacterState`

| Field | Type | Role |
|---|---|---|
| `body` | `CharacterBody` | Rapier KCC capsule (`@mp/physics`) |
| `vx`, `vz` | m/s | horizontal locomotion velocity (own momentum) |
| `vy` | m/s | vertical velocity; 0 while riding |
| `grounded` | boolean | footing as of end of last step; what animation and `STATE_GROUNDED` read |
| `base` | `MovementBase \| undefined` | `{ colliderHandle, localPos }` — ridden surface and position **in its frame** |
| `carry` | `Vec3` | output only: world velocity received without asking (ride, shove, wall). x/z = `(applied − v·dt)/dt`; y = ride only |
| `launch` | m/s | pending upward speed set from outside (bumper, ADR 0032); consumed by the step |
| `impulse` | `Vec3` | pending velocity **added** by the step (ADR 0059); zeroed in place after use; `y > 0` leaves the surface, flat keeps footing |
| `coyote` | s | grace remaining; refilled on footing, spent to 0 on leaving |
| `jumpBuffer` | s | press pending; refilled while `cmd.jump`, spent on fire |
| `jumpCut` | boolean | current rise is a player jump cuttable by release; cleared by cut, launch, landing |
| `liftVel`, `liftStore` | `Vec3`, s | last ride velocity and how long it stays on offer |

Constructors: `addCharacter(world, spawn, layers?)`, `addCharacterWith(world, spawn, opts)` (tests/experiments). `playerSpawn(id)` — deterministic fallback ring (r 5 m, y 2).

## `stepCharacter`

```ts
stepCharacter(state: CharacterState, cmd: InputCommand, dt: number,
              tuning = DEFAULT_TUNING, platforms?: PlatformPoseLookup): void
type PlatformPoseLookup = (colliderHandle: number) => PlatformFrame | undefined
interface PlatformFrame { position: Vec3; rotation: Quat }
```

`InputCommand` (`@mp/core`): `moveX`, `moveZ` (−1..1, world space, normalised if `|v| > 1`), `jump`, `actions`. Deterministic; mutates `state` only. Call after platforms are posed and stepped for the tick.

Step order:

1. Footing: `body.probeGround()` (+ one deeper probe for the ridden base if missed).
2. `jumping = jumpBuffer > 0 && (grounded || coyote > 0)`; `leaving = jumping || launch > 0 || impulse.y > 0` spends both windows. Launch outranks jump.
3. Jump cut when `jumpCut && !cmd.jump && vy > 0`.
4. Vertical: riding → `vy = 0`; else gravity × scale, clamp `−maxFallSpeed`.
5. Horizontal via `approachVec`. Ground rate `min(moveSpeed / (hasInput ? groundAccelTime : groundStopTime), ceiling)`, where the ceiling is `groundMaxAccel` when the change **adds** to current velocity and `groundBrakeMaxAccel` when it fights it; air rate `min(accel·airControl, airMaxAccel)`. Above `moveSpeed` only `moveSpeed` worth is steered; the excess is carried untouched (no air-strafing gain).

   Which ceiling is decided by the component of the needed change along the direction of travel, not by comparing magnitudes: halfway through a reversal the target is larger than what is left, so magnitudes would read it as a start and let it round at the uncapped rate. A turn at speed is therefore braking, which is the point (ADR 0096). Uncapped is not instant — the time-based rate still applies.
6. Leaving adds ride velocity (`ride/dt`, or `liftVel` from a coyote jump). Impulse added, zeroed.
7. `body.move(desired)`: own `v·dt` + ride delta; vertical is the trapezoid `½(v₀+v₁)·dt` except when settling.
8. Update `carry`, `grounded`, `coyote`, `liftVel/liftStore`; ceiling cancels rise; `base` re-anchored.

### `approachVec` (ADR 0078)

Moves `(vx, vz)` toward the target by at most `maxDelta` **along the difference vector**, not per axis: direction preserved, arrival time camera-independent.

### Movement base (ADR 0021)

- Held while the probe finds the same collider, not on `grounded` (flickers).
- Position re-derived each tick from `base.localPos` under the frame's current pose; never nudged by a delta.
- Ridden piece must be posed with zero derived velocity (`LoadedLevel.update(base?.colliderHandle)`) or Rapier double-applies.
- `base.localPos` is what a rider sends on the wire (v10).
- Jump/launch off a mover inherits ride velocity; walking off inherits nothing.

## Envelope (measured, `DEFAULT_TUNING`)

`pnpm exec vitest run packages/humanoid/src/envelope --project unit` (repo root). Tests **print** these and assert only `> 0` / `true`; no value is pinned. Below: current run.

| Quantity | Value |
|---|---|
| Air time (parabola, no apex float) | 0.627 s |
| Take-off speed | 17.2 m/s |
| Max gap, running (5 m run-up) | 4.0 m |
| Max gap, standing | 4.4 m |
| Max gap vs landing rise: −2 / −1 / 0 / +0.5 / +1 / +1.5 / +2 / +2.5 m | 4.5 / 4.3 / 4.1 / 4.0 / 3.8 / 3.6 / 3.5 / 3.2 m |
| Step-up, no jump (autostep) | 0.45 m |
| Step-up, jump | 3.1 m |
| Beam off-centre margin, width 0.2 / 0.4 / 0.6 / 0.8 / 1.2 / 2.0 m | ±0.35 / 0.45 / 0.55 / 0.65 / 0.85 / 1.00 m |
| Slope drift standing 4 s | ≤44°: ≤0.01 m; 48°: slides off |
| Standable band from crown, dome r=1/2/4 | 40° / 50° / 60° |
| Standable band from crown, log r=1/2/4 | 45° / 50° / 60° |

The `DEFAULT_TUNING` comment quoting a 3.6 m gap predates ADR 0041; the current envelope run gives the numbers above (autostep 0.45 m).

## `createLocomotion` / `LOCOMOTION_DEF` (`locomotion.ts`)

```ts
interface LocomotionDeps {
  readonly character: () => CharacterState | null
  readonly tuning: () => CharacterTuning
  readonly platforms?: () => PlatformPoseLookup | undefined
}
createLocomotion(deps: LocomotionDeps, type = 'Locomotion'): ComponentDef<Record<string, never>>
LOCOMOTION_DEF: ComponentDef<Record<string, never>>   // bound to () => null / DEFAULT_TUNING
```

- `attachesTo: 'player'`, `singleton: true`, `params: {}`; `onLocomote(_self, ctx, cmd)` → `stepCharacter(char, cmd, ctx.dt, tuning(), platforms?.())`, between the host's two physics half-steps.
- Game passes getters (session-scoped). `LOCOMOTION_DEF` goes in the registry for validation; the session definition (`PlayerEntity.defs`) runs.
- No params by design: `deps.tuning()` keeps the debug pane's live object the single source (ADR 0057). In `@mp/tps` that is `TpsClient.tuning`; the descriptor's object is copied and inert.
