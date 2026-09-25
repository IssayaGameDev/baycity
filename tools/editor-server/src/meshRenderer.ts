import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import {
  ASSETS_DIR,
  LEVELS_DIR,
  LEVEL_SUFFIX,
  MESH,
  RENDERER,
  childListsOf,
  effectiveNode,
  firstOfType,
  modelOf,
  stringParam,
  type ComponentData,
  type Level,
  type Node,
  type NodeOverride,
  type TypeInfo,
} from '@mp/content'

/**
 * One Mesh Renderer (ADR 0153): every `Mesh` folds into the `Renderer` beside it, as its `model`, and goes.
 *
 * - **An object's own** Mesh: its model into its Renderer, which keeps its id — so what a placement overrides on
 *   that Renderer still names it. A Mesh with no Renderer drew nothing, and becomes a switched-off Renderer
 *   holding the model, which draws nothing either.
 * - **What a placement records** against a prefab piece's Mesh moves onto that piece's Renderer: a changed
 *   model, and a Mesh switched off or removed there — which drew the colliders, so it becomes that Renderer's
 *   model cleared. A Mesh a placement added folds the same way.
 * - Prefab files and levels both: a level's records are remapped from its prefabs **before** they fold.
 *
 * Every file is checked: what each object draws — whether, what model, what material, and everything else it
 * carries — must be the same after as before, or nothing is written at all. Runs from the box's own checkout,
 * after the deploy that taught the loader the new shape (`migrate-mesh-renderer.sh`).
 */

export interface Folded {
  /** Meshes folded into a Renderer. */
  meshes: number
  /** Placement records moved from a Mesh onto its Renderer. */
  records: number
}

/** Every component type repeatable: both sides of a comparison use it, which is all it has to be. */
const ANY_TYPE: TypeInfo = { get: () => undefined }

/** Where a piece's Mesh went: its own id, and the Renderer that holds its model now (the same id when it became one). */
interface Moved {
  readonly mesh: string
  readonly renderer: string
}

/**
 * Fold a component list in place. `null` when there is no Mesh; otherwise where it went, or why it cannot go.
 *
 * A Mesh switched off with a model of its own is refused: it drew nothing of its model, and folding would either
 * draw it or lose it.
 */
const foldList = (list: ComponentData[]): Moved | { problem: string } | null => {
  const meshes = list.filter((c) => c.type === MESH)
  if (meshes.length === 0) return null
  if (meshes.length > 1) return { problem: 'two Meshes on one object' }
  const mesh = meshes[0]!
  const model = stringParam(mesh, 'model', '')
  if (mesh.enabled === false && model !== '') return { problem: `a switched-off Mesh holding '${model}' — switch it on or delete it` }
  const renderer = list.find((c) => c.type === RENDERER)
  const at = list.indexOf(mesh)
  if (renderer === undefined) {
    // Drew nothing: a Renderer switched off, holding the model, draws nothing too, and keeps the Mesh's id.
    list.splice(at, 1, { id: mesh.id, type: RENDERER, enabled: false, params: { model, material: '' } })
    return { mesh: mesh.id, renderer: mesh.id }
  }
  // A Renderer's own model already wins over the Mesh (`modelOf`); otherwise the Mesh's becomes its own.
  if (stringParam(renderer, 'model', '') === '' && mesh.enabled !== false) {
    const rest = { ...renderer.params }
    delete rest.model
    renderer.params = { model, ...rest }
  }
  list.splice(at, 1)
  return { mesh: mesh.id, renderer: renderer.id }
}

/** A prefab's pieces, by id, for the records naming them: where each one's Mesh went, and each one's Renderer after. */
interface Pieces {
  readonly moved: Map<string, Moved>
  readonly renderer: Map<string, string>
}
const noPieces = (): Pieces => ({ moved: new Map(), renderer: new Map() })

/** Fold a tree of own nodes in place — a prefab's, or a level's — and say where each Mesh went. */
const foldTree = (roots: readonly Node[], count: Folded, problems: string[], where: string, pieces?: Pieces): void => {
  const walk = (n: Node): void => {
    const moved = foldList(n.components)
    if (moved !== null) {
      if ('problem' in moved) problems.push(`${where} ${n.name ?? n.id}: ${moved.problem}`)
      else {
        count.meshes += 1
        pieces?.moved.set(n.id, moved)
      }
    }
    const renderer = n.components.find((c) => c.type === RENDERER)
    if (renderer !== undefined) pieces?.renderer.set(n.id, renderer.id)
    for (const kids of childListsOf(n)) for (const kid of kids) walk(kid)
  }
  for (const n of roots) walk(n)
}

/** Move one placement record's mentions of a piece's Mesh onto its Renderer. */
const foldRecord = (over: NodeOverride, moved: Moved, count: Folded): void => {
  const { mesh, renderer } = moved
  let touched = false
  const onRenderer = (patch: Record<string, unknown>): void => {
    over.params = { ...over.params, [renderer]: { ...over.params?.[renderer], ...patch } }
    touched = true
  }
  const patch = over.params?.[mesh]
  if (patch !== undefined && renderer !== mesh) {
    delete over.params![mesh]
    onRenderer(patch)
  }
  // Off or removed here, the Mesh left this placement drawing the colliders: the Renderer's model, cleared.
  if (renderer !== mesh && over.enabled?.[mesh] !== undefined) {
    if (over.enabled[mesh] === false) onRenderer({ model: '' })
    delete over.enabled[mesh]
    touched = true
  }
  if (renderer !== mesh && over.removed?.includes(mesh) === true) {
    over.removed = over.removed.filter((id) => id !== mesh)
    onRenderer({ model: '' })
  }
  if (touched) count.records += 1
}

/**
 * A Mesh a placement added to a piece. Beside a Renderer it added too, the two fold as an object's own do; beside
 * the piece's own Renderer, with no Mesh of the piece's in the way, its model becomes that Renderer's on this
 * placement.
 */
const foldAdded = (over: NodeOverride, key: string, pieces: Pieces | undefined, count: Folded, problem: (p: string) => void): void => {
  const added = over.added!
  const mesh = added.find((c) => c.type === MESH)
  if (mesh === undefined) return
  const rendererId = pieces?.renderer.get(key)
  if (!added.some((c) => c.type === RENDERER) && rendererId !== undefined && pieces?.moved.has(key) !== true) {
    const model = stringParam(mesh, 'model', '')
    if (mesh.enabled === false && model !== '') return problem(`a switched-off Mesh holding '${model}' — switch it on or delete it`)
    if (mesh.enabled !== false) over.params = { ...over.params, [rendererId]: { ...over.params?.[rendererId], model } }
    over.added = added.filter((c) => c !== mesh)
    count.meshes += 1
    return
  }
  const moved = foldList(added)
  if (moved === null) return
  if ('problem' in moved) problem(moved.problem)
  else count.meshes += 1
}

/** Tidy what a record emptied, as `ops.ts` does. */
const tidy = (owner: Node): void => {
  const map = owner.overrides
  if (map === undefined) return
  for (const [key, over] of Object.entries(map)) {
    if (over.params !== undefined && Object.keys(over.params).length === 0) delete over.params
    if (over.enabled !== undefined && Object.keys(over.enabled).length === 0) delete over.enabled
    if (over.removed !== undefined && over.removed.length === 0) delete over.removed
    if (over.added !== undefined && over.added.length === 0) delete over.added
    if (Object.keys(over).length === 0) delete map[key]
  }
  if (Object.keys(map).length === 0) delete owner.overrides
}

/**
 * Fold a level in place. `piecesOf(id)` is where each piece's Mesh went in that prefab — the level's own table
 * first, then the asset — worked out before either folded.
 */
export const foldLevel = (level: Level, piecesOf: (prefabId: string) => Pieces | undefined, where: string): { count: Folded; problems: string[] } => {
  const count: Folded = { meshes: 0, records: 0 }
  const problems: string[] = []
  const own = new Map<string, Pieces>()
  for (const [id, root] of Object.entries(level.prefabs ?? {})) {
    const pieces = noPieces()
    foldTree([root], count, problems, `${where} (its copy of ${id})`, pieces)
    own.set(id, pieces)
  }
  const walk = (n: Node): void => {
    const moved = foldList(n.components)
    if (moved !== null) {
      if ('problem' in moved) problems.push(`${where} ${n.name ?? n.id}: ${moved.problem}`)
      else count.meshes += 1
    }
    if (n.prefab !== undefined && n.overrides !== undefined) {
      const pieces = own.get(n.prefab) ?? piecesOf(n.prefab)
      for (const [key, over] of Object.entries(n.overrides)) {
        if (over.added !== undefined) foldAdded(over, key, pieces, count, (p) => problems.push(`${where} ${n.name ?? n.id}: what it adds to ${key}: ${p}`))
        const moved = pieces?.moved.get(key)
        if (moved !== undefined) foldRecord(over, moved, count)
      }
      tidy(n)
    }
    for (const kids of childListsOf(n)) for (const kid of kids) walk(kid)
  }
  for (const n of level.nodes) walk(n)
  return { count, problems }
}

/** Keys sorted, so the same parameters in another order are not a difference. */
const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : typeof v === 'object' && v !== null
      ? Object.fromEntries(
          Object.keys(v as Record<string, unknown>)
            .sort()
            .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
        )
      : v

/**
 * What every object draws, as lines — switched-off ones included, since switching one back on must find it
 * as it was: whether it draws, its model (`modelOf`, which reads a Mesh too), its material, and every other
 * component whole. The check a fold must pass: the same lines before and after.
 */
export const drawnLines = (level: Level, definitionOf: (prefabId: string) => Node | undefined): string[] => {
  const ids = new Set<string>()
  const collect = (n: Node): void => {
    if (n.prefab !== undefined) ids.add(n.prefab)
    for (const kids of childListsOf(n)) for (const kid of kids) collect(kid)
  }
  for (const n of level.nodes) collect(n)
  const table: Level = { ...level, prefabs: { ...Object.fromEntries([...ids].map((id) => [id, definitionOf(id)]).filter((e): e is [string, Node] => e[1] !== undefined)), ...level.prefabs } }
  const out: string[] = []
  const walk = (n: Node, path: string): void => {
    const r = effectiveNode(table, n, ANY_TYPE)
    const here = `${path}/${r.id}`
    const renderer = firstOfType(r.components, RENDERER)
    const rest = r.components.filter((c) => c.type !== MESH && c.type !== RENDERER).map((c) => `${c.type}#${c.id}${c.enabled === false ? ':off' : ''}=${JSON.stringify(canon(c.params))}`)
    out.push(
      `${here}${r.enabled === false ? ' (off)' : ''} | ${renderer === undefined ? 'draws nothing' : `draws ${modelOf(r.components) || 'its colliders'} in ${stringParam(renderer, 'material', '') || 'grey'} (${renderer.id})`} | ${rest.join(' ')}`,
    )
    for (const kid of r.children) walk(kid, here)
  }
  for (const n of level.nodes) walk(n, '')
  return out
}

/** Two spaces and a trailing newline, as the content API writes a file. */
const serialise = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`

const filesUnder = (dir: string, suffix: string): string[] => {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const full = join(at, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith(suffix)) out.push(full)
    }
  }
  walk(dir)
  return out
}

/** One file the fold changes. */
export interface FoldChange {
  /** Relative to the content directory. */
  file: string
  before: string
  after: string
  count: Folded
}

export interface FoldPlan {
  changes: FoldChange[]
  /** What cannot fold as it is, named — the plan is then not to be written at all. */
  problems: string[]
  /** Files whose drawing the fold would change — which should never happen, and is why it is checked. */
  refused: string[]
  /** Files that do not parse, left alone. */
  unreadable: string[]
}

/** Every prefab and level under `contentDir` the fold would change, and how. Reads only. */
export const planFold = (contentDir: string): FoldPlan => {
  const changes: FoldChange[] = []
  const problems: string[] = []
  const refused: string[] = []
  const unreadable: string[] = []

  // Prefabs first: their pieces' moves are what the levels' records are remapped by.
  const before = new Map<string, Node>()
  const after = new Map<string, Node>()
  const pieces = new Map<string, Pieces>()
  for (const full of filesUnder(join(contentDir, ASSETS_DIR), '.prefab.json')) {
    const file = relative(contentDir, full)
    let text: string
    let id: string | undefined
    try {
      text = readFileSync(full, 'utf8')
      const meta = existsSync(`${full}.meta`) ? (JSON.parse(readFileSync(`${full}.meta`, 'utf8')) as { id?: unknown }) : {}
      id = typeof meta.id === 'string' ? meta.id : undefined
      JSON.parse(text)
    } catch {
      unreadable.push(file)
      continue
    }
    const root = JSON.parse(text) as Node
    const count: Folded = { meshes: 0, records: 0 }
    const map = noPieces()
    foldTree([root], count, problems, file, map)
    if (id !== undefined) {
      before.set(id, JSON.parse(text) as Node)
      after.set(id, root)
      pieces.set(id, map)
    }
    if (count.meshes === 0) continue
    const shown = (r: Node): string[] => drawnLines({ id: 'prefab', config: {}, nodes: [r] }, () => undefined)
    if (shown(JSON.parse(text) as Node).join('\n') !== shown(root).join('\n')) refused.push(file)
    else changes.push({ file, before: text, after: serialise(root), count })
  }

  const games = existsSync(contentDir)
    ? readdirSync(contentDir)
        .filter((name) => name !== ASSETS_DIR && statSync(join(contentDir, name)).isDirectory())
        .sort()
    : []
  for (const game of games) {
    for (const full of filesUnder(join(contentDir, game, LEVELS_DIR), LEVEL_SUFFIX)) {
      const file = relative(contentDir, full)
      let text: string
      let level: Level
      try {
        text = readFileSync(full, 'utf8')
        level = JSON.parse(text) as Level
      } catch {
        unreadable.push(file)
        continue
      }
      const drawn = drawnLines(JSON.parse(text) as Level, (id) => before.get(id))
      const { count, problems: here } = foldLevel(level, (id) => pieces.get(id), file)
      problems.push(...here)
      if (count.meshes + count.records === 0) continue
      if (drawnLines(level, (id) => after.get(id)).join('\n') !== drawn.join('\n')) refused.push(file)
      else changes.push({ file, before: text, after: serialise(level), count })
    }
  }
  return { changes, problems, refused, unreadable }
}

/** What is left to fold: Meshes anywhere in these files. `0` once the migration is done. */
export const meshesLeft = (texts: readonly string[]): number => texts.reduce((n, t) => n + (t.match(/"type":\s*"Mesh"/g)?.length ?? 0), 0)
