# Humanoid ground controller (`@mp/humanoid`)

`packages/humanoid/src/groundController.ts`. One kinematic-capsule controller: fixed-apex jump, time-based ground accel/brake, force-limited air control, riding moving surfaces (ADR 0012), following the ground it stands on (ADR 0127). Client-authoritative, run by each client for its own body (ADR 0011). Reached by a game through `createLocomotion` (ADR 0061); not "the" platform controller (ADR 0062).

## Moving the character from outside (ADR 0100)

`releaseFooting(state)`. Call it whenever something that is not `stepCharacter` sets the body's position — a
respawn, a stage teleport. Clears `base`, `carry`, `liftVel`, `liftStore`, `slopeReach`, the three velocities
and `grounded`.

**`base` is the one that bites.** Left set, the second-look bounce-fall guard (step 1 below) can re-acquire the
platform the character was standing on and then move it to its stored *local* spot on that platform — a
respawn followed one tick later by a yank into the air. It also reaches peers: while `base` is set the wire
carries the local position (ADR 0021), so everyone else draws the character on that platform.

`coyote` and `jumpBuffer` are deliberately not cleared (ADR 0100).

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
| `airDrag` | 1/s | 0 | fraction of horizontal speed lost per airborne second, stick or no stick: `v *= 1/(1 + airDrag·dt)`; 0 = off (ADR 0107) |
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
| `slopeReach` | m | extra ground-probe reach, = last tick's step length if that step descended a slope, else 0 (ADR 0127) |

Constructors: `addCharacter(world, spawn, layers?)`, `addCharacterWith(world, spawn, opts)` (tests/experiments). `playerSpawn(id)` — deterministic fallback ring (r 5 m, y 2).

## `stepCharacter`

```ts
stepCharacter(state: CharacterState, cmd: InputCommand, dt: number,
              tuning = DEFAULT_TUNING, platforms?: PlatformPoseLookup): void
type PlatformPoseLookup = (colliderHandle: number) => PlatformFrame | undefined
interface PlatformFrame { position: Vec3; rotation: Quat }
```

`InputCommand` (`@mp/core`): `moveX`, `moveZ` (−1..1, world space, normalised if `|v| > 1`), `jump`, `actions`. Deterministic; mutates `state` only. Call after platforms are posed and stepped for the tick.

**Riding a fast deck has a ceiling per physics step**: about `halfHeight + radius` of deck travel, ~1.2 m, i.e. a deck at ~36 m/s at 30 Hz. Past that `move()` will not sweep the capsule out of the deck it is inside, so the client slices the tick (`LoadedLevel.motionSlices`, ADR 0104) rather than the character — slicing the character alone makes it worse, and sweeping the platform instead of teleporting it does nothing.

Step order:

1. Footing: `body.probeGround()`, then for the ridden base if that missed — a **deeper** probe when the base dropped away (ADR 0042), or the base kept **without** a probe when it rose past the capsule's centre (ADR 0104), bounded by `-away <= 2 × (halfHeight + radius)`, the point still being overhead, and `vy <= 0`.
1b. Footing is `!leaving && (vy <= 0 || **arrived**)`, where `arrived` means the probe met the surface **above** the soles — it came to us (ADR 0105). `vy <= 0` alone refused a deck arriving under a jump, and a controller pushes nothing out of a kinematic body that moved into it, so the platform swept through. An arrival also cancels the remaining climb.
2. `jumping = jumpBuffer > 0 && (grounded || coyote > 0)`; `leaving = jumping || launch > 0 || impulse.y > 0` spends both windows. Launch outranks jump.
3. Jump cut when `jumpCut && !cmd.jump && vy > 0`.
4. Vertical: riding → `vy = 0`; else gravity × scale, clamp `−maxFallSpeed`.
5. Horizontal via `approachVec`. Ground rate `min(moveSpeed / (hasInput ? groundAccelTime : groundStopTime), ceiling)`, where the ceiling is `groundMaxAccel` when the change **adds** to current velocity and `groundBrakeMaxAccel` when it fights it; air rate `min(accel·airControl, airMaxAccel)`. Above `moveSpeed` only `moveSpeed` worth is steered; the excess is carried untouched (no air-strafing gain).

   **Air drag** then runs on the result, every airborne tick, whether or not there is input:
   `vx, vz *= 1 / (1 + airDrag·dt)`. After the steering, so the excess air control may not spend decays too
   (a fling slows); before step 6, so the tick you leave a mover hands you its velocity whole. Implicit form,
   because `1 − k·dt` reverses the character once `k·dt > 1` and `k` is a live slider. `state.grounded` is last
   tick's footing, the same reading the branch above uses, so a jump's take-off tick is undragged.

   Reach cost, measured, identical at every `moveSpeed` from 2.8 to 283 m/s (`airDrag` 0.5): **−1.6 % holding
   the stick, −16.2 % coasting**. Holding forward costs almost nothing because air control refills the tick's
   loss on the next tick; the drag's real bite is a release, and anything above `moveSpeed`.

   Which ceiling is decided by the component of the needed change along the direction of travel, not by comparing magnitudes: halfway through a reversal the target is larger than what is left, so magnitudes would read it as a start and let it round at the uncapped rate. A turn at speed is therefore braking, which is the point (ADR 0096). Uncapped is not instant — the time-based rate still applies.
6. Leaving adds ride velocity (`ride/dt`, or `liftVel` from a coyote jump). Impulse added, zeroed.
6b. **Slope following** (ADR 0127). Not riding, with footing that is staying put (`settling`) and `state.grounded` as of last tick, the vertical carries what keeps the soles on the probe's plane: `slopeDy = −(n.x·dx + n.z·dz) / n.y`, added to the settling press. Zero while airborne, leaving or rising, so no arc and no envelope number moves. `n.y` needs no guard — `probeGround` rejects anything flatter than the 50° limit.
7. `body.move(desired, snapAtLeast)`: own `v·dt` + ride delta horizontally; **riding, the vertical seats the soles on the probe contact** (`under.point.y + 0.02 − feetY`, ADR 0105) rather than repeating the anchor's motion, which is what stopped a boarding gap being carried. Not riding, `slopeDy` plus the trapezoid `½(v₀+v₁)·dt`, except when settling where the press is `vy·dt`. Descending a slope, `snapAtLeast` is the step's own length and is also stored in `slopeReach` for next tick's probe: the resolve intermittently returns part of a step, and snap-to-ground is the only thing that absorbs the remainder (ADR 0127).
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

## Slopes (ADR 0127)

A grounded character follows the surface under it. **Speed is unchanged** going up, down and flat: no gravity
gain downhill, no cost uphill, because in keyboard Max Speed is what a Level buys and a hill that moved it
would move a stage's gate. Running off a crest glues to the far side; only a jump leaves the ground. Climb
limit 50°, slide above 45°, both unchanged (`@mp/physics`).

Measured, 10°–45°, 2.8 to 58.8 m/s, up and down (`packages/humanoid/src/slopes.test.ts`):

| Quantity | Value |
|---|---|
| Ticks without footing | none, at any angle or speed in that range |
| Steady clearance | the 0.02 m contact offset |
| Worst transient gap | 0.67 m (10°) and 0.21 m (20°), both at 58.8 m/s, recovered in a tick or two |
| Worst depth uphill | within 0.22 m of the flat-ground resting depth |
| Flat-ground resting depth | **−0.039 m** — a capsule creeps this far into whatever it stands on under the per-tick press, slope or not, and always has. Not a slope defect |

Above the authored curve the tick is the limit, not the slope: at 283 m/s a step is 9.4 m against a 2 m
capsule, and on 25° and steeper the capsule tunnels through. Sub-stepping does not help (measured worse),
the same wall ADR 0104 hit from the platform side.

Before ADR 0127, for comparison: running down 30° gave 41 % of ticks airborne at 5.5 m/s, 90 % at 30 m/s,
and one 155 m launch at 283 m/s; uphill the capsule sat 0.05–0.30 m inside the surface, and below 17.5° it
went through.

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
