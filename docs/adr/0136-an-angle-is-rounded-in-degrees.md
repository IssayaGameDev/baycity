# ADR 0136 — An angle is rounded in degrees

Status: accepted.

## Context

Kodjo typed a rotation of 0 90 0; reselected, it read 0 89.9998 0.

The file stores Euler radians and the Inspector shows degrees. Every write-back rounded the radians to four
decimals, as it does positions: 90° became 1.5708, which is 90.0002°. About Y that is the XYZ decomposition's
gimbal lock, where `asin` folds anything past 90 back under it, so it read 89.9998. Every other angle drifted
as well, less visibly: 45° was saved as 45.0002°.

## Decision

**`roundAngle` (`tools/editor/src/snap.ts`) rounds to four decimals of a degree and stores the radians that
gives, unrounded.** Used wherever a write-back rounded a rotation: `transformOfGroup`, `writeBackItem`,
`groupPose`, and the reparent's reframe. A typed whole degree reads back as typed; 90° is stored as
`1.5707963267948966`.

Positions and scales keep `r4`: they are shown in the unit they are stored in, so rounding them there is exact.

Existing files still hold `1.5708` and read 89.9998 until the rotation is written again.

## Rejected

- **More decimals of radians** (`1e6`, `1e8`). Smaller drift, still drift, and no reason to prefer it over
  rounding in the unit a person reads.
- **Storing degrees.** A file-format change touching every level, the loader and the game, for a display bug.
- **Fixing the read-back** (a gimbal-aware decomposition). The stored value would still be 90.0002°.
