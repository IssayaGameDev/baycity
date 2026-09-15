# ADR 0098 — A placement can override its prefab root's components

Status: accepted. Completes ADR 0033's override model, which covered a prefab's children and not its root.

## Context

Kodjo resized the collider on his kill plane and got
`no component 'c0' on node '99b8faab'`, with the value sticking in the Inspector and no effect in the level.

The kill plane is a **prefab placement**, and the `Collider` belongs to the prefab's **root**.

The editor decided where a component write should land by asking one question — is this node inherited, or its
own — and a placement answers "its own", because it is. But a placement's visible component list is the prefab
root's layered with its own (`effectiveNode`), so the write was aimed at the placement, which does not have
that component.

Three writers, three different symptoms:

| Writer | Before |
| --- | --- |
| `setParams` | threw `no component 'c0' on node '<id>'`. The Inspector had already written into the object its slider is bound to, so the value stuck on screen while nothing reached the level |
| `removeComponent` | a guard on `authored.components` made it **silently do nothing** |
| `setComponentEnabled` | same guard, same silence |

Silence is the worse half: a checkbox that does nothing reads as the component not mattering.

Only the root is affected. A prefab's *children* are pushed with the placement as their `owner`, so editing
them has always produced a correct override. Every test fixture in `editorDoc.test.ts` put the geometry on a
prefab's child, which is exactly why none of them found this.

## Decision

**Three cases where there were two**, in one shared `writeTarget(node, componentId)`:

1. an inherited child → an override on the placement that owns it, keyed by the child
2. a component the node actually has → edit it directly
3. **a component the node shows but does not have** → it came from this placement's prefab root, so an
   override on the placement, keyed by the **root's** id

The third needs no new op and no schema change. An override record is keyed by node id and `bakeOverrides`
looks the root up by its own id, so a record under the root's id has always reached it — nothing ever wrote one.

`setParams` resolves the target **per component id**, not once, because the built-in-shape branch (ADR 0090)
writes to several components at once and on a placement some may be its own while others came from the root.

**`moveComponent` is deliberately left refused.** Order is the order hooks run in, it belongs to the prefab's
own list, and no per-placement override expresses it — the same reason it is already refused for an inherited
child.

## Rejected

- **Making a placement's root components read-only in the Inspector.** Honest about the old limitation and a
  worse product: per-placement size is exactly what an override is for.
- **Editing the prefab definition instead.** That is what "Open prefab" is for. Silently turning a
  per-placement tweak into an edit of every placement everywhere is the drift ADR 0091 was written to end.
- **Giving the placement a second `DocNode` row for its prefab root**, so the root's components would have an
  owner like a child's. Uniform, and it would put a phantom row in the Hierarchy and shift every index below
  it — which is what ADR 0091's notes warn about for saved indices.
- **Keeping the silent guards on remove and enable.** They were hiding this.

## Consequences

- A placement can now be resized, have a root component switched off, or have one removed, without touching
  the prefab. The Inspector's revert affordance already handles the resulting override.
- `writeTarget` returns `null` when a component is neither the node's nor resolvable through a prefab, so a
  stale Inspector click is a no-op rather than a throw.
- `editorDoc.test.ts` gained a fixture whose prefab **root** carries the geometry. Reverting the fix makes four
  of its tests fail with Kodjo's exact message, which is the only evidence that they test anything.
