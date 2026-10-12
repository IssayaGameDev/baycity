# Stage gates

`modes/keyboard/src/components/stageGate.ts` (ADR 0202). The places a teleport window will send a player to.
The window itself is not built yet.

## `StageGate`

No params. Singleton. No collider needed. Placed on an empty object where a player should stand (its position
is the feet), turned the way they should face (its +Z). Put once in a prefab — the `InterLevel` stage-break —
every placement has one.

Not the shared `Checkpoint` (Kodjo's call): that one's meaning, a respawn point, and any settings it grows are
every game's. A gate does not change where you respawn: falling is still the spawn ([stages-and-wins.md](stages-and-wins.md)).

Every gate is open for now. Later, Kodjo's plan: reached by passing through a trigger, and a Wins price to unlock.

## The list

```ts
stageGatesOf(loaded: Pick<LoadedLevel, 'allNodes'>, standOffset: number): StageGateStop[]
interface StageGateStop { number: number; position: Vec3; yaw: number }
```

Hierarchy order — `allNodes`, depth first, parents before children — numbered from 1, so a gate inside a
placement is numbered where the placement sits. `position` = the node's world position + `standOffset`
(`STAND_OFFSET`, as a spawn is). `yaw` = `yawOf(rotation)`, the character's convention.

## In the editor

`KEYBOARD_MODE.facingGizmos`: a blue disc and post (`MARKER_COLORS.spawn`) with an arrow along the gate's
forward, under the toolbar's Markers toggle.
