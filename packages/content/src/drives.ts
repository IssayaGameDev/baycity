import { componentsOfType, type Drive, type TypeInfo } from './nodes'
import type { ComponentData } from './types'

/**
 * Every node something drives, with what (ADR 0210): each enabled component whose type `drives` names a target,
 * resolved from the driving node by `find` — the loader's scopes or the editor's — in the order the drivers come, so
 * of two drives on one parameter the later wins. A target that does not resolve, and a driver whose parameters cannot
 * be read, drive nothing.
 */
export const drivesOf = <N>(
  nodes: readonly N[],
  componentsOf: (n: N) => readonly ComponentData[],
  find: (from: N, id: string) => N | undefined,
  types: TypeInfo,
): Map<N, Drive[]> => {
  const out = new Map<N, Drive[]>()
  for (const n of nodes)
    for (const c of componentsOf(n)) {
      if (c.enabled === false) continue
      const drives = types.get(c.type)?.drives
      if (drives === undefined) continue
      let list: readonly Drive[]
      try {
        list = drives(c.params)
      } catch {
        continue
      }
      for (const d of list) {
        if (d.ref === null || d.ref.node === '') continue
        const target = find(n, d.ref.node)
        if (target === undefined) continue
        const at = out.get(target)
        if (at === undefined) out.set(target, [d])
        else at.push(d)
      }
    }
  return out
}

/**
 * `drivesOf`, followed down a chain (ADR 0222): a driven component's own drives read what it was driven to — Keyboard's
 * World sets an Obstacle's Wins, which the Obstacle sets on its pad. Each pass reads every node's components with the
 * last pass's drives over them, so a chain of `passes` links settles; drives are recomputed, never stacked.
 */
export const settleDrives = <N>(
  nodes: readonly N[],
  componentsOf: (n: N) => readonly ComponentData[],
  find: (from: N, id: string) => N | undefined,
  types: TypeInfo,
  passes = 4,
): Map<N, Drive[]> => {
  let map = drivesOf(nodes, componentsOf, find, types)
  for (let k = 1; k < passes; k++) {
    const last = map
    map = drivesOf(nodes, (n) => drivenComponents(componentsOf(n), last.get(n) ?? []), find, types)
  }
  return map
}

/**
 * `components` with each drive's parameters over its target's own: the enabled component of the drive's type with
 * the reference's id, or the first of the type for `''`. A target that is not there is skipped. A new array and new
 * component objects: a node's components may be shared with every other placement of its prefab.
 */
export const drivenComponents = (components: readonly ComponentData[], drives: readonly Drive[]): ComponentData[] => {
  let out = [...components]
  for (const d of drives) {
    const ofType = componentsOfType(out, d.type)
    const id = d.ref?.component ?? ''
    const target = id === '' ? ofType[0] : ofType.find((c) => c.id === id)
    if (target === undefined) continue
    out = out.map((c) => (c === target ? { ...c, params: { ...c.params, ...d.params } } : c))
  }
  return out
}
