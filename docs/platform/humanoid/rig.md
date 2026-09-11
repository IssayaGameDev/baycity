# Humanoid rig (`@mp/humanoid`)

`packages/humanoid/src/humanoidRig.ts`. One skeleton: 11 rigid boxes, no skinning, no art (ADR 0062). Geometry is data; `@mp/render-three` builds one nested node per part and poses it by joint rotation. Everything is in **root space, origin at the capsule centre** — what the sim reports as the character position.

## Constants

| Symbol | Value | Meaning |
|---|---|---|
| `CHAR_HEIGHT` | 2.0 m | `(CHAR_HALF_HEIGHT + CHAR_RADIUS)·2`; matches the collider |
| `CHAR_WIDTH` | 0.8 m | `CHAR_RADIUS·2` |
| `FOOT_Y` | −1.0 m | root-space y of the sole, `−(CHAR_HALF_HEIGHT + CHAR_RADIUS)` |
| `LIMB_LENGTH` | 0.375 m | each half of an arm or leg (two-bone IK segment) |
| `HIP_HEIGHT` | −0.25 m | hip joint y before any bob (`FOOT_Y + 2·LIMB_LENGTH`) — legs at full extension when standing |

Module-private: `TORSO_H` 0.75, `HEAD` 0.5, `WAIST_Y` 0.3 (body height), `CHEST_H` 0.45, `SHOULDER_Y` = `HIP_Y + 0.65`. Proportions: head 0.5 + torso 0.75 + leg 0.75 = 2.0 m; shoulders 0.5 + 2×0.15 = 0.8 m.

## Parts

```ts
type PartName = 'body' | 'chest' | 'head'
  | 'upperArmL' | 'lowerArmL' | 'upperArmR' | 'lowerArmR'
  | 'upperLegL' | 'lowerLegL' | 'upperLegR' | 'lowerLegR'
interface RigPart { parent: PartName | null; pivot: Vec3; size: Vec3; meshOffset: Vec3; style: 'skin' | 'shirt' | 'trousers' }
const RIG: Record<PartName, RigPart>
const PART_NAMES: PartName[]   // insertion order; every parent precedes its children
```

- `pivot` — joint position relative to the parent's joint (root space when `parent === null`).
- `size` — box dimensions.
- `meshOffset` — box centre relative to the joint. Upward parts: `+h/2`; hanging limbs: `−LIMB/2` on y, so a joint rotation swings the limb rather than spinning it about its middle.
- L side = `x < 0`, R side = `x > 0`.

| Part | Parent | Pivot (x, y, z) | Size | meshOffset y | Style |
|---|---|---|---|---|---|
| `body` | `null` | (0, −0.25, 0) hip line | 0.5 × 0.3 × 0.3 | +0.15 | shirt |
| `chest` | `body` | (0, 0.3, 0) waist | 0.5 × 0.45 × 0.3 | +0.225 | shirt |
| `head` | `chest` | (0, 0.45, 0) | 0.5 × 0.5 × 0.5 | +0.25 | skin |
| `upperArmL/R` | `chest` | (∓0.325, 0.35, 0) | 0.15 × 0.375 × 0.15 | −0.1875 | skin |
| `lowerArmL/R` | `upperArmL/R` | (0, −0.375, 0) | 0.15 × 0.375 × 0.15 | −0.1875 | skin |
| `upperLegL/R` | `body` | (∓0.14, 0, 0) | 0.2 × 0.375 × 0.2 | −0.1875 | trousers |
| `lowerLegL/R` | `upperLegL/R` | (0, −0.375, 0) | 0.2 × 0.375 × 0.2 | −0.1875 | trousers |

Upper-arm pivot y = `SHOULDER_Y − HIP_Y − WAIST_Y` = 0.35 (chest frame). Waist split: `body` carries legs, `chest` carries arms and head, so a twist above the waist turns shoulders while hips stay square; the share is the gait's `spineChestShare`.

## `Pose`

```ts
interface Pose {
  yaw: number                              // root facing, rad about +y
  rotation: Record<PartName, Quat>         // each joint's local rotation
  bodyOffset: Vec3                         // body joint translation (bob, sway, crouch, hip lag); leg IK solves against it
  jointOffset: Record<PartName, Vec3>      // per-joint translation from its pivot, in the PARENT's frame
}
restPose(): Pose                           // yaw 0, identity quats, zero offsets
```

`jointOffset` is non-zero only for `head`, `upperArmL`, `upperArmR` (gait joint-lag layer). Body travel is `bodyOffset`; leg parts stay at zero (planted feet).

## `partTransforms`

```ts
interface PartTransform { position: Vec3; rotation: Quat }
partTransforms(pose: Pose, origin: Vec3): Record<PartName, PartTransform>
```

Forward kinematics of the whole rig for a character rooted at world `origin`. Per part, in `PART_NAMES` order:

1. `local = pivot + jointOffset[name] + (name === 'body' ? bodyOffset : 0)`
2. `jointPos = parentPos + rotate(parentRot, local)`; root parent = `origin`, `quatFromY(pose.yaw)`
3. `jointRot = parentRot · rotation[name]`
4. `position = jointPos + rotate(jointRot, meshOffset)` — the **box centre**, not the joint; `rotation = jointRot`

Same walk the renderer does; headless so a ragdoll and a spawn assembly can take the exact drawn pose (`createRagdoll({ transforms: partTransforms(pose, at) })`, `assembly.draw(partTransforms(pose, at), …)` in `packages/tps/src/avatars.ts`).

## World-space parts via `TpsClient.partsOf`

```ts
// packages/tps/src/client.ts
partsOf: (id: EntityId) => Record<PartName, PartTransform> | null
```

Chain: `TpsClient.partsOf` → `Avatars.partsOf` (`avatars.ts`, forwards `views.partsOf`) → `CharacterViews.partsOf` (`characterView.ts`):

```ts
partsOf: (id) => { const r = chars.get(id); return r === undefined || r.pose === null ? null : partTransforms(r.pose, r.last) }
```

- `r.pose` — the pose the rig was **last drawn** in; `r.last` — the rendered position (interpolated, out of any platform frame). `null` until the first frame draws that character.
- Drawn, not simulated: rigs animate per rendered frame, so read it inside `TpsClient.onFrame` (called after bodies and camera are placed). Reading from `onFixedUpdate` repeats the same answer across frames.
- `Avatars.poseOf(id)` returns the raw `Pose` (root space) for the same character.
