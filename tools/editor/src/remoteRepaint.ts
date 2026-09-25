import { SEQUENCE, type NodeRef, type Op } from '@mp/content'

/**
 * What a batch of ops made elsewhere — a collaborator's edit, an undo — needs redrawn (ADR 0167). Pure.
 *
 * The full redraw rebuilt every object's meshes for any edit but a move: 45 ms on a level of 400 objects after
 * ADR 0167's other fixes, half a second before them, for every edit anyone made. Most edits touch one object, and
 * a node's meshes depend only on it and what is above it (a material or a switch-off inherits), so rebuilding its
 * subtree is the same picture. What moves objects about — an insert, a removal, a reparent — renumbers them, and a
 * prefab's definition or the game reaches every placement: those still redraw everything. So does any op this
 * does not know, so a new kind can only ever cost time, never draw stale.
 *
 * A sequence can fade other objects, which then need copies of their own materials (ADR 0141): a change to one is
 * a full redraw too.
 */
export interface Repaint {
  /** Redraw everything: the tree's shape, a prefab's definition or the game changed, or an op this does not know. */
  all: boolean
  /** Rebuild these nodes' meshes, and everything under each; an Inspector showing one draws again. */
  nodes: NodeRef[]
  /** The sky and the light, or a setting the environment's Inspector shows. */
  environment: boolean
}

/** Only a label: nothing drawn in the viewport changes. */
const LABELS = new Set<string>(['setName', 'setOverrideName'])
/**
 * What changes one node and what is under it, and nothing else. Every other kind — an insert, a removal, a
 * reparent, a prefab's table, the game, a placement's child list, an op added after this — redraws everything.
 */
const ONE_NODE = new Set<string>([
  'setTransform',
  'setOverrideTransform',
  'setParams',
  'setComponentEnabled',
  'setNodeEnabled',
  'addComponent',
  'removeComponent',
  'moveComponent',
  'setOverrideParams',
  'setOverrideEnabled',
  'setOverrideNodeEnabled',
  'setOverrideRemoved',
  'addOverrideComponent',
  'removeOverrideComponent',
])

/** The node an op is about, as a ref. */
const refOf = (op: Op): NodeRef | null => {
  if ('owner' in op && 'node' in op) return { owner: op.owner, node: op.node }
  if ('id' in op) return { id: op.id }
  return null
}

/** The component an op is about, and its type when the op carries the component itself. */
const componentOf = (op: Op): { id: string; type?: string } | null => {
  if (op.kind === 'addComponent' || op.kind === 'addOverrideComponent') return { id: op.component.id, type: op.component.type }
  if ('componentId' in op) return { id: op.componentId }
  return null
}

/**
 * `typeOf(ref, componentId)`: the component's type as the document has it now, after the ops — `undefined` when
 * it is not there (removed), which counts as possibly a sequence.
 */
export const repaintFor = (ops: readonly Op[], typeOf: (ref: NodeRef, componentId: string) => string | undefined): Repaint => {
  const plan: Repaint = { all: false, nodes: [], environment: false }
  for (const op of ops) {
    if (op.table === undefined && (op.kind === 'setEnvironment' || op.kind === 'setCameraSeeThrough')) {
      plan.environment = true
      continue
    }
    if (op.table === undefined && LABELS.has(op.kind)) continue
    const ref = op.table === undefined && ONE_NODE.has(op.kind) ? refOf(op) : null
    if (ref === null) {
      plan.all = true
      continue
    }
    const c = componentOf(op)
    if (c !== null) {
      const type = c.type ?? typeOf(ref, c.id)
      // Gone — it may have been one — or a sequence, which may fade another object.
      if (type === undefined || type === SEQUENCE) {
        plan.all = true
        continue
      }
    }
    // A transform among other ops: its subtree, since a scale changes the meshes (ADR 0090).
    plan.nodes.push(ref)
  }
  return plan
}
