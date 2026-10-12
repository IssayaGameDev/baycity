# Sequences — `packages/content/src/sequence.ts`

An object's motion as **stages of steps**, a pure function of time (ADR 0137). Timing is ours; the easing
formulas are `d3-ease` (ADR 0138). Headless, in `@mp/content`, because the loader and the editor's preview are
two readers of one rule.

**The only motion there is**: `Mover` and `Spinner` are deleted (ADR 0137), and `strip-motion.sh` took them
out of the content (`editor-server.md`). The loader runs sequences (`content.md`, ADR 0141), the editor's
Motion button previews them (ADR 0142), the Inspector edits them (`editor.md`, ADR 0143), and the viewport
drags a move's point and draws the route (`editor.md`, ADR 0144).

## Data

```ts
Sequence { name; clock: 'shared'|'local'; axes: 'object'|'level'; loop: 'restart'|'yoyo';
           times /* passes, 0 = forever */; offset /* fraction of the cycle */; stages: Stage[] }
Stage    { id; steps: Step[] }
Step     = { id; target? /* a child's id; absent = the object */ } & (
  | { kind: 'move';  to: Vec3;   timing; ease }     // a point from where it was placed
  | { kind: 'turn';  axis: Vec3; angle /* deg, by */; timing; ease }
  | { kind: 'scale'; to: Vec3;   timing; ease }     // × the scale it was placed at
  | { kind: 'fade';  to: number; timing; ease }     // × its material's opacity
  | { kind: 'collider'; on } | { kind: 'enabled'; on } | { kind: 'wait'; seconds } )
Timing   = { by: 'seconds'; seconds } | { by: 'speed'; speed } | { by: 'stage'; speed? /* turn: spin at this rate */ }
EASES    // 31: 'linear', then in-/out-/in-out- × sine quad cubic quart quint expo circ back elastic bounce
```

`EASES` lives in `eases.ts`, which imports nothing: checking a stored sequence needs it and is reached from the
editor's `vite.config.ts` (`editor-server.md`).

## Stored — `sequenceData.ts`

A `Sequence` component (`SEQUENCE`, repeatable) carries the settings as ordinary parameters and `stages` as the
`stages` parameter kind (`components/api.md`).

```ts
stagesProblem(v, at?): string | null     // whole, with a JSON path; ids unique across stages and steps
stepProblem(v, at): string | null
readStages(v): readonly Stage[]           // [] if they do not check out
sequenceOf(c: ComponentData): Sequence    // defensive, like every loader reader
```

**A placement's differences** (ADR 0139), `NodeOverride.sequences[componentId]`:

```ts
SequenceOverride { steps?: Record<stepId, StepPatch>; removedSteps?; removedStages?; addedSteps?: Step[];
                   addedStages?: string[]; layout?: { stage; steps: string[] }[] }
stagesFor(prefab, record): readonly Stage[]      // what the placement shows
diffStages(prefab, shown): SequenceOverride | undefined   // its inverse; undefined when they agree
```

| | |
| --- | --- |
| a patch | the fields that differ; `target: ''` = the object itself; a different `kind` = the whole step; one that would make the step invalid is ignored |
| `layout` | only when the rest would order things differently. A preference: gone ids skipped, unmentioned ones at the end of their own stage (inherited) or of the last stage (added) |
| a removed stage | takes its steps, unless the layout moved them elsewhere |
| baking | `patchComponents` (`nodes.ts`), after the params patch, on `Sequence` components only |
| op | `setOverrideSequence{owner, node, componentId, override \| null}` — the whole record; refused for a component the placement added, which is edited as one |

`stagesFor(p, diffStages(p, s))` is `s`, asserted over a thousand random edits in `sequenceData.test.ts`.

**Step targets are node references.** `retargetStages`, `retargetSequenceParams`, `retargetSequenceOverride`
repoint them when a subtree's ids are re-minted; `unlinkedNode` and the editor's `reidSubtree` both do.

## API

```ts
compileSequence(s): CompiledSequence   // once per edit: every start and duration, problems
sequenceTime(c, nowMs): number         // seconds into a pass: the looping, and only here
restartsBetween(c, from, to): boolean  // a `restart` crossed into a pass that plays: a cut (ADR 0206)
sampleSequence(c, { shared, local }): ReadonlyMap<target, SequencePose>   // SELF = '' for the object
combineSequences(parts: { pose, axes }[], at: NodeFrame): SequenceOffset
easeAt(ease, t)                        // exact 0 and 1 at the ends
```

`CompiledSequence { passSeconds; cycleSeconds; stages: {id,start,duration}[]; steps: Map<id, Span>; problems; targets }`.
`SequencePose { position; turn: Quat; scale; opacity; collider?; enabled? }` — one sequence, one target, its own
axes. `SequenceOffset` — the same, framed and combined: `position` added to the authored local position,
`rotation` multiplied on the right (`local = authored · rotation`), `scale` × authored, `opacity` clamped
`[0,1]`, `collider`/`enabled` `undefined` when nobody has said. `UNMOVED` when no sequence touches a node.

## Rules

| | |
| --- | --- |
| a stage | as long as its longest step that ends by itself; `stage`-timed steps get that length. None ⇒ 0 s, `stage-has-no-end` |
| a move at a speed | distance from where its target stands **when its stage starts** (previous stage's point, or where placed) ÷ speed |
| a turn at a speed | `|angle| ÷ |speed|`. `stage` + `speed` spins at that rate for the stage; `stage` alone turns `angle` over it |
| speed | the average: an ease redistributes time inside the step, never changes its length |
| instant steps | at the start of their stage; a stage of only instants lasts 0 s and is not a problem |
| same channel, same stage | both start from where the target stood; the later in the list wins while both run |
| before a step says | `collider`/`enabled` `undefined`: the object as it was set up |
| turns within a sequence | about axes that stay put, each later one applied after (left-multiplied) |
| restart | at exactly `passSeconds` it is already the next pass's start, so an instant step at the very end is never seen unless the passes are counted and it holds. The jump back is a **cut** (`restartsBetween`, ADR 0206): the loader takes it as a teleport — no sweep, no velocity, no blend, no ride — never as travel; not the hold after the last pass |
| yo-yo | odd passes read `pass − u`: moves, eases and instant steps all rewind; a final wait counts twice |
| `times` | then holds where the last pass ended: the far end, or the start for an even yo-yo count (DOTween's `SetLoops`) |
| `offset` | `frac(offset) × cycleSeconds`; the cycle is two passes for a yo-yo |

**Problems** (`SequenceProblem`): `stage-has-no-end`, `goes-nowhere` (a move to where it is, a turn with no
angle or axis), `speed-not-positive`, `speed-not-allowed` (a speed on scale or fade). The step still plays and
takes no time.

## Combining several on one node

| channel | rule |
| --- | --- |
| position | adds. `object` axes: rotated by the authored rotation; `level`: un-rotated by the parent's world rotation; then ÷ parent scale (ADR 0106) |
| rotation | stacks in component order. `object`: as is; `level`: conjugated so `world = turn · parent · authored` |
| scale, opacity | multiply |
| collider, enabled | off wins; on only when nobody says off |

`NodeFrame { parentRot; parentScale; ownRotation }` — the loader builds one per frame (`frameOf`), with the
parent's **live** world rotation and scale.

## In the game — `loader.ts` (ADR 0141)

| channel | reaches |
| --- | --- |
| move, turn | the frame's local pose, added to the authored position; a turn is multiplied onto the authored rotation on the right |
| scale | the frame's world scale, and every frame under it; collider shapes re-set with `setShape` when it changed; `VisualItem.drawScale` stretches what is drawn |
| fade | `VisualItem.opacity`, on the target only — not its children; the renderer fades an own copy of the material |
| collider on / off | the target's own bodies, `setEnabled` — not its children's |
| enable / disable | the target **and its branch**: not drawn, bodies off, lights off |

A `Collider` switched off in the Inspector is not built, so no step can switch it on. `WorldNode.colliders`
stays the load-time size: a rule measuring a volume reads it as built.

Riding: `sequenceRide.test.ts` (`@mp/tps`) rides a sequence lift through the loader and the character as the
game ticks them, sliced, to 10 cm at up to a 63 m/s peak; without slicing it falls 434 m.

## Tests — `sequence.test.ts`

Kodjo's three cases (ball, fading platform, wall), every timing rule, yo-yo mirroring on every channel, repeat
and offset, both clocks, order-independence over 500 shuffled instants, ten hours into a room, and the frames
checked against what the frame tree does with them. Reverting the yo-yo rewind, chaining the points, or
last-wins for off each fails them.
