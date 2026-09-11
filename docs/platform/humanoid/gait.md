# Humanoid gait (`@mp/humanoid`)

`packages/humanoid/src/bipedGait.ts`. Procedural walk / run / idle / air cycle for the 11-part rig (ADR 0018). Pure math: `AnimationInput` in, `Pose` out, per rendered frame. Bipedal by construction; a game with a new state replaces the animator (ADR 0063).

## API

```ts
interface AnimationInput {
  yaw: number          // facing, rad
  speed: number        // planar locomotion m/s, EXCLUDING platform carry — the stride odometer
  vy?: number          // own vertical m/s, excluding carry; joint-lag layer only
  grounded: boolean
  rising: boolean      // vy > 0 as told by the sim / STATE_RISING
  carry?: Vec3         // CharacterState.carry; inertia reacts to its derivative
}
interface Animator { step: (input: AnimationInput, dt: number) => Pose }
type AnimatorFactory = (gait: GaitTuning, seed: number, states: () => ReadonlySet<string>) => Animator
createAnimator(tuning = DEFAULT_GAIT, seed = 1): Animator
solveTwoBone(forward, up, a, b, bendForward): { parent: number; child: number }
```

- `createAnimator` matches `AnimatorFactory` (third arg ignored); it is the default factory in `packages/tps/src/characterView.ts` (`makeAnimator = createAnimator`), called per character with seed `id · 2654435761`.
- `step` returns the same mutated `Pose` object each frame.
- `seed` → mulberry32; per-movement variation is local and cosmetic.

## Phase: distance, not time

`phase += speed·dt / (2·stride)` while `grounded` (one cycle = two strides). `speed` is surface-relative locomotion, so feet plant correctly on movers and a teleport cannot spin the legs. Foot follows `footTarget` (stance: linear back; swing: sine lift), hip/knee from `solveTwoBone` in the leg's actual parent frame. Variation rolls per footfall (`beat = floor(phase·2)`), per takeoff, per landing — never per frame.

Blends: `moveBlend = clamp(speed/1.2)` (gait in from idle; full below walking pace so feet cover real distance); `intensity = clamp(speed/runSpeed)` scales flourishes only. `airBlend`, `riseBlend` via `blendHalfLife`.

## `GaitTuning` (`DEFAULT_GAIT`)

### Cycle

| Field | Unit | Default | Meaning |
|---|---|---|---|
| `strideWalk` | m | 0.9 | stride at walking pace |
| `strideRun` | m | 1.7 | stride at `runSpeed` |
| `runSpeed` | m/s | 5.5 | speed at which stride, bob, lean, armSwing, torsoTwist, headSprint saturate (`t = clamp(speed/runSpeed)`) |
| `footLift` | m | 0.3 | swing-phase peak lift |
| `bob` | m | 0.12 | hip drop, twice per cycle, × intensity |
| `lean` | rad | 0.18 | forward lean at top speed |
| `armSwing` | rad | 1.4 | arm pitch amplitude, opposite the legs |
| `armOutward` | rad | 0.16 | constant arm splay (legibility from a rear camera) |
| `elbowBase` | rad | 0.3 | permanent elbow bend |
| `elbowFold` | rad | 0.95 | extra fold on forward swing |
| `torsoTwist` | rad | 0.14 | shoulders vs hips counter-rotation |
| `spineChestShare` | 0..1 | 0.75 | fraction of torso lean/twist/tilt taken at the waist (`chest`) vs hips (`body`) |
| `variation` | × | 1 | per-movement multiplier spread (log-space roll); 0 = off |
| `yawHalfLife` | s | 0.06 | facing smoother |
| `blendHalfLife` | s | 0.08 | gait/air and rise/fall blend smoothers |
| `landCrouch` | rad | 0.5 | knee bend on landing; hip drop `crouch·landCrouch·0.25` |

### Caps (ADR 0079)

| Field | Unit | Default | Meaning |
|---|---|---|---|
| `maxStrideRate` | strides/s | `Infinity` | `stride = max(blend, speed/maxStrideRate)` — past it stride grows so cadence holds. Keyboard: 3.25 |

### Air pose

| Field | Unit | Default | Meaning |
|---|---|---|---|
| `airArmRise` / `airArmFall` | rad | 2.2 / 0.7 | arm pitch rising / falling |
| `airArmOutRise` / `airArmOutFall` | rad | 0.5 / 1.0 | arm outward roll rising / falling |
| `airElbowRise` / `airElbowFall` | rad | 1.2 / 0.2 | elbow bend rising / falling |
| `airTuckRise` / `airTuckFall` | m | 0.36 / 0.05 | foot lift rising / falling |
| `airAsymArm` / `airAsymLeg` | 0..1 | 1 / 1 | contralateral lead/trail asymmetry while rising; lead side alternates per jump |

Internal constants: `ARM_ASYM_OUT` 0.35, `ARM_ASYM_PITCH` 0.35 rad, `LEG_ASYM_FWD` 0.18 m.

### Idle (time clock, runs only while idle)

| Field | Unit | Default | Meaning |
|---|---|---|---|
| `idleSettle` | m | 0.025 | standing hip drop; the slack the layer spends (hip line = 2 bone lengths) |
| `breathPeriod` | s | 2 | breathing cycle |
| `breathDepth` | m | 0.02 | must stay `< idleSettle` |
| `idleShiftPeriod` | s | 2 | weight-shift interval (× rolled variation) |
| `idleSway` | m | 0.015 | lateral hip travel at full shift |
| `idleRoll` | rad | 0.015 | torso counter-roll against the shift |

### Inertia

Response is to **acceleration** of total world velocity (locomotion from `yaw·speed` + `carry`), as `atan(a / G_REF)` with `G_REF = 55`. Two derivative paths: locomotion sampled over `inertiaSampleHalfLife`, carry over fixed `CARRY_SAMPLE_HALFLIFE` 0.12 s; both responses smoothed over `inertiaHalfLife`.

| Field | Unit | Default | Meaning |
|---|---|---|---|
| `inertiaStrength` | × | 1 | overall; 0 disables |
| `inertiaLateral` | 0..1 | 1 | scales sideways (roll) response only, applied once to `lagRight`. Keyboard: 0.35 |
| `inertiaHalfLife` | s | 0.12 | response smoother |
| `inertiaSampleHalfLife` | s | 0.03 | locomotion acceleration window |
| `inertiaAccelCap` | m/s² | `Infinity` | planar acceleration scaled down as a vector to this; vertical clamped separately. Keyboard: 55 |
| `inertiaBody` | × | 0.35 | torso lag weight |
| `inertiaHead` | × | 0.15 | head lag weight |
| `inertiaUpperArm` | × | 1 | upper-arm lag weight |
| `inertiaLowerArm` | × | 0.6 | forearm pitch lag, on top of the upper arm |
| `inertiaHip` | m | 0.05 | hip travel per unit tilt (legs show inertia via IK); grounded only |
| `inertiaVertical` | m | 0.34 | body compression on upward accel |
| `inertiaFloat` | rad | 1.95 | arms float up on downward accel |

### Head

| Field | Unit | Default | Meaning |
|---|---|---|---|
| `headStabilize` | 0..1 | 0.7 | share of spine base rotation cancelled (slerp of conjugate) |
| `headYawHalfLife` | s | 0.03 | head's own facing smoother; shorter than `yawHalfLife` = leads |
| `headYawMax` | rad | 0.7 | lead/trail clamp |
| `headRise` / `headFall` | rad | 0.2 / 0.25 | chin up rising / look down falling |
| `headLand` | rad | 0.3 | nod on impact, decays with crouch |
| `headSprint` | rad | 0.06 | forward pitch × intensity |

### Joint lag (translation, world space; `LAG_PARTS` = head, upperArmL, upperArmR)

`follow()` — first-order trail behind the attachment point driven by smoothed world velocity (`LAG_VELOCITY_HALFLIFE` 0.12 s) + bob rate (`BOB_RATE_HALFLIFE` 0.04 s); settles at `v·halfLife/ln2`, clamped as a vector. Output written to `Pose.jointOffset` in the chest frame. Head drive has the fore/aft axis projected out.

| Field | Unit | Default | Meaning |
|---|---|---|---|
| `headLagHalfLife` | s | 0.007 | 0 welds |
| `headLagMax` | m | 0.09 | |
| `armLagHalfLife` | s | 0.01 | ≈79 mm trail at 5.5 m/s |
| `armLagMax` | m | 0.11 | |

## Arm inward clamp (ADR 0079)

Upper-arm roll = `side·(outward + breathOut + floatUp) + hang + lagRight·inertiaUpperArm`; then `bounded = side === 1 ? max(roll, 0) : min(roll, 0)`. An arm never rolls inward past vertical. Forearm gets pitch only.

## What a game overrides (`packages/tps/src/client.ts`)

| `TpsClientOptions` field | Effect |
|---|---|
| `gait?: GaitTuning` | retunes the shared cycle; copied on entry (`{ ...(mode.gait ?? DEFAULT_GAIT) }`), that copy is live for the debug pane and every animator |
| `animator?: AnimatorFactory` | **replaces** `createAnimator` for every character (`AvatarsOptions.makeAnimator`); wrap `createAnimator` to add a state. `states()` gives the game's wire-carried state names for that character (ADR 0064) |

Inputs to `step` come from `CharacterPlacement` in `characterView.ts`: self supplies `yaw/speed/vy/carry` from its sim; peers get `yaw/speed/vy` differenced from the rendered position when `null`, with `carry.y` subtracted from `vy`.
