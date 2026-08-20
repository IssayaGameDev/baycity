import type { Level, Piece, Prefab, PrefabInstance, PieceOverride, Visual } from './types'

/**
 * Resolve an instance's prefab: an inline definition is itself, an id is looked up in
 * `Level.prefabs`. Referencing is the whole point of that table — one entry, many instances, edit
 * once — so the lookup lives here rather than inside the loader, where the editor could not reach it
 * and would grow a second definition of the same rule.
 */
export const resolvePrefab = (level: Level, inst: PrefabInstance): Prefab => {
  if (typeof inst.prefab !== 'string') return inst.prefab
  const found = level.prefabs?.[inst.prefab]
  if (found === undefined) throw new Error(`prefab '${inst.prefab}' not found in level.prefabs`)
  return found
}

/**
 * The pieces of `inst`'s prefab **as this placement sees them**: the prefab's own, with the instance's
 * overrides applied (ADR 0033).
 *
 * One definition, shared by the loader and the editor, for the same reason `resolvePrefab` is: two of them
 * would eventually disagree, and the symptom would be a level that looks one way in the tool and behaves
 * another in the game.
 *
 * Returns **fresh objects only for the pieces that changed**, and the prefab's own object otherwise. That is
 * deliberate: the editor writes through the objects it is handed for the shared definition, and copying
 * unconditionally would silently turn a prefab edit into a no-op.
 */
export const effectivePieces = (level: Level, inst: PrefabInstance): Piece[] => {
  const pieces = resolvePrefab(level, inst).pieces
  const overrides = inst.overrides
  // `inst.material` is the blunt all-pieces override, and it beats a piece's own (ADR 0028).
  if (overrides === undefined && inst.material === undefined) return pieces
  return pieces.map((piece) => applyOverride(piece, inst.material, piece.id === undefined ? undefined : overrides?.[piece.id]))
}

/** Which piece fields this placement has overridden — what the Inspector marks and what "revert" removes. */
export const overriddenFields = (over: PieceOverride | undefined): (keyof PieceOverride)[] => {
  if (over === undefined) return []
  const keys: (keyof PieceOverride)[] = ['transform', 'material', 'trigger', 'behavior', 'name']
  return keys.filter((k) => over[k] !== undefined)
}

const withMaterial = (visual: Visual | undefined, material: string): Visual | undefined => {
  // `''` means "explicitly none here", which for a primitive is no visual at all and for a model is the
  // mesh's own material.
  if (visual?.kind === 'model') return material === '' ? { kind: 'model', asset: visual.asset } : { ...visual, material }
  return material === '' ? undefined : { kind: 'primitive', material }
}

const applyOverride = (piece: Piece, instanceMaterial: string | undefined, over: PieceOverride | undefined): Piece => {
  if (over === undefined && instanceMaterial === undefined) return piece
  const out: Piece = { ...piece }
  if (over?.transform !== undefined) out.transform = over.transform
  if (over?.name !== undefined) out.name = over.name
  if (over?.behavior !== undefined) out.behavior = over.behavior
  if (over?.trigger !== undefined) {
    if (over.trigger.kind === 'none') delete out.trigger
    else out.trigger = over.trigger
  }
  // Per-piece material first, then the instance-wide one, which is the coarser statement and wins.
  // `exactOptionalPropertyTypes` means clearing is a `delete`, not an assignment of `undefined`.
  const setVisual = (v: Visual | undefined): void => {
    if (v === undefined) delete out.visual
    else out.visual = v
  }
  if (over?.material !== undefined) setVisual(withMaterial(out.visual, over.material))
  if (instanceMaterial !== undefined) setVisual(withMaterial(out.visual, instanceMaterial))
  return out
}

/**
 * One placed instance, found by walking the tree, with everything needed to address it: who its parent
 * is, and which array it lives in and where. Reordering splices within `siblings`; reparenting splices
 * from one `siblings` into another.
 */
export interface InstanceVisit {
  inst: PrefabInstance
  parent: PrefabInstance | null
  siblings: PrefabInstance[]
  /** Position within `siblings`. */
  index: number
  /** 0 for a top-level instance. */
  depth: number
}

/**
 * Every instance in the level, **depth-first, parents before children** — one definition of that order,
 * shared by the loader (where it fixes the movement-base numbering every client must agree on) and the
 * editor (where it is the row order of the hierarchy).
 */
export const walkInstances = (level: Level): InstanceVisit[] => {
  const out: InstanceVisit[] = []
  const visit = (siblings: PrefabInstance[], parent: PrefabInstance | null, depth: number): void => {
    siblings.forEach((inst, index) => {
      out.push({ inst, parent, siblings, index, depth })
      if (inst.children !== undefined) visit(inst.children, inst, depth + 1)
    })
  }
  visit(level.instances, null, 0)
  return out
}

/** The instances referencing `id`, at any depth — what "3 instances" in the editor counts. */
export const instancesOf = (level: Level, id: string): PrefabInstance[] =>
  walkInstances(level)
    .filter((v) => v.inst.prefab === id)
    .map((v) => v.inst)

/**
 * A table id for `prefab` that will not collide with a *different* prefab already in `table`.
 * Same id and same content reuses the entry — placing the same kit piece twice shares one — while
 * same id, different content takes a numeric suffix. Content compared with the id blanked, since
 * the id is exactly what is allowed to differ.
 */
export const freeTableId = (table: Record<string, Prefab>, prefab: Prefab): string => {
  const body = JSON.stringify({ ...prefab, id: '' })
  const same = (a: Prefab): boolean => JSON.stringify({ ...a, id: '' }) === body
  const at = table[prefab.id]
  if (at === undefined || same(at)) return prefab.id
  for (let n = 2; ; n++) {
    const id = `${prefab.id}-${n}`
    const other = table[id]
    if (other === undefined || same(other)) return id
  }
}
