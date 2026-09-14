import { vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { fingerprintGeometry } from './fingerprint'
import { matchEntry, migrateLevelRefs, newRefReport, type PrefabFile } from './migratePrefabRefs'
import type { ComponentData, Level, Node } from './types'

const TYPES = { get: () => undefined }
const comp = (id: string, type: string, params: Record<string, unknown> = {}): ComponentData => ({ id, type, params })
const box = (half: number, h: number): Record<string, unknown> => ({ shape: { kind: 'box', halfExtents: vec3(half, h, half) } })
const UNIT = { shape: { kind: 'box', halfExtents: vec3(0.5, 0.5, 0.5) } }

const file = (assetId: string, name: string, root: Node): PrefabFile => ({ assetId, name, root })

/** The prefab file as the primitives migration left it: a unit collider sized by scale, with a Mesh. */
const trampolineFile = (): Node => ({
  id: 'root',
  name: 'Trampoline',
  transform: { position: vec3(0, 0, 0) },
  components: [],
  children: [
    {
      id: 'p0',
      name: 'pad',
      transform: { position: vec3(0, 0, 0), scale: vec3(3, 0.3, 3) },
      components: [comp('c0', 'Collider', UNIT), comp('mesh', 'Mesh', { model: 'builtin:rounded-box' }), comp('c1', 'Renderer', { material: 'mat' }), comp('c2', 'Bumper', { power: 26 })],
    },
  ],
})

/** The same trampoline as a level interned it before that migration: half extents, no Mesh, another node id. */
const trampolineCopy = (): Node => ({
  id: 'root',
  name: 'Trampoline',
  transform: { position: vec3(0, 0, 0) },
  components: [],
  children: [{ id: '91521042', name: 'pad', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', 'Collider', box(1.5, 0.15)), comp('c1', 'Renderer', { material: 'mat' }), comp('c2', 'Bumper', { power: 26 })] }],
})

const levelWith = (table: Record<string, Node>, nodes: Node[]): Level => ({ id: 'lv', config: {}, prefabs: table, nodes })

describe('matching a table entry to a prefab file', () => {
  const pad = (): Node => ({ id: 'root', name: 'pad', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', 'Collider', UNIT)] })

  it('matches by content, ignoring the name the entry is keyed under', () => {
    const m = matchEntry('FastElevator', { ...pad(), name: 'FastElevator' }, [file('aaa', 'AlternatingDanger', pad())])
    expect(m?.by).toBe('content')
    expect(m?.file.name, 'the contents decide, not the key').toBe('AlternatingDanger')
  })

  /** The real trap: an entry named `FastElevator` whose contents are the `AlternatingDanger` file. */
  it('prefers the file whose contents agree over the file whose name agrees', () => {
    const files = [file('aaa', 'AlternatingDanger', pad()), file('bbb', 'FastElevator', { ...pad(), children: [pad()] })]
    expect(matchEntry('FastElevator', { ...pad(), name: 'FastElevator' }, files)?.file.name).toBe('AlternatingDanger')
  })

  it('matches the same shape under different node ids, and pairs them up', () => {
    const renamed = pad()
    renamed.components[0]!.id = 'c0'
    const entry: Node = { ...pad(), id: 'root', children: [{ id: 'mine', transform: { position: vec3(0, 0, 0) }, components: [] }] }
    const target: Node = { ...pad(), id: 'root', children: [{ id: 'theirs', transform: { position: vec3(0, 0, 0) }, components: [] }] }
    const m = matchEntry('x', entry, [file('aaa', 'x', target)])
    expect(m?.by).toBe('ids')
    expect(m?.remap).toEqual({ mine: 'theirs' })
  })

  it('falls back to the name, and says so', () => {
    const different: Node = { ...pad(), components: [comp('c9', 'Collider', box(9, 9))] }
    expect(matchEntry('pad', { ...pad(), name: 'pad' }, [file('aaa', 'pad', different)])?.by).toBe('name')
  })

  it('finds nothing when no file is close', () => {
    expect(matchEntry('Stage End', pad(), [])).toBeNull()
  })
})

describe('migrating a level to references', () => {
  /** The placement, with the override the real content carries: a moved pad, a material and power 60. */
  const placement = (key: string, node: string): Node => ({
    id: 'trampoline',
    name: 'trampoline',
    transform: { position: vec3(-6, 0.15, 4) },
    components: [],
    prefab: key,
    overrides: { [node]: { transform: { position: vec3(24.5, 0, -5.5) }, params: { c1: { material: 'other' }, c2: { power: 60 } } } },
  })

  /**
   * The case that needs every rule at once, taken from the real content. The file is the same trampoline
   * expressed differently — unit collider plus scale, where the interned copy used half extents — so neither
   * content rule matches it and it is adopted **by name**, which is the risky match. Its pad has another id,
   * and the override carries only a position, which `bakeOverrides` would let wipe the file's scale, turning a
   * 3 × 0.3 × 3 pad into a unit cube. What makes adopting it safe is the gate: the level draws and collides
   * identically afterwards, line for line, or the rewrite is thrown away.
   */
  it('relinks, remaps the override key and completes its transform, so nothing resolves differently', () => {
    const level = levelWith({ Trampoline: trampolineCopy() }, [placement('Trampoline', '91521042')])
    const before = fingerprintGeometry(level, TYPES)
    const report = newRefReport()

    expect(migrateLevelRefs(level, 'lv', [file('aaa', 'Trampoline', trampolineFile())], TYPES, report)).toBe(true)

    const moved = level.nodes[0]!
    expect(moved.prefab, 'the reference is the asset id').toBe('aaa')
    expect(Object.keys(moved.overrides!), 'the override followed the node it names').toEqual(['p0'])
    expect(moved.overrides!['p0']!.transform!.scale, "completed from the file's node, or the pad would shrink").toEqual(vec3(3, 0.3, 3))
    expect(moved.overrides!['p0']!.params!['c2'], 'the tuned bumper is still tuned').toEqual({ power: 60 })
    expect(fingerprintGeometry(level, TYPES), 'identical, line for line').toEqual(before)
    expect(report.linked[0]).toMatchObject({ key: 'Trampoline', assetId: 'aaa', by: 'name', placements: 1, remapped: 1 })
    expect(report.refused).toEqual([])
  })

  it('throws the rewrite away and reports when the level would resolve differently', () => {
    const level = levelWith({ Trampoline: trampolineCopy() }, [placement('Trampoline', '91521042')])
    const untouched = structuredClone(level)
    // A file that is not the same prefab, in a way no override masks: a pad of another size.
    const wrong = trampolineFile()
    wrong.children![0]!.transform = { position: vec3(0, 0, 0), scale: vec3(9, 9, 9) }
    const report = newRefReport()

    expect(migrateLevelRefs(level, 'lv', [file('aaa', 'Trampoline', wrong)], TYPES, report)).toBe(false)
    expect(level, 'left exactly as it was').toEqual(untouched)
    expect(report.refused).toHaveLength(1)
    expect(report.refused[0]!.why).toContain('changed')
    expect(report.linked, 'nothing is reported as done').toEqual([])
  })

  /**
   * A definition differing only where every placement overrides it is **not** a difference: nobody can see the
   * value, so adopting the file is safe. The gate answers the question that matters — does the level draw and
   * collide the same — rather than whether two JSON trees are equal.
   */
  it('accepts a file that differs only where the placement overrides it', () => {
    const level = levelWith({ Trampoline: trampolineCopy() }, [placement('Trampoline', '91521042')])
    const masked = trampolineFile()
    masked.children![0]!.components[3] = comp('c2', 'Bumper', { power: 5 }) // the override says 60 regardless
    const report = newRefReport()
    expect(migrateLevelRefs(level, 'lv', [file('aaa', 'Trampoline', masked)], TYPES, report)).toBe(true)
    expect(level.nodes[0]!.overrides!['p0']!.params!['c2']).toEqual({ power: 60 })
  })

  it('asks for a file to be created for an entry no file matches, and changes nothing yet', () => {
    const stageEnd: Node = { id: 'root', name: 'Stage End', transform: { position: vec3(0, 0, 0) }, components: [], children: [{ id: 'plat', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', 'Collider', UNIT)] }] }
    const level = levelWith({ 'Stage End': stageEnd }, [{ id: 'n0', transform: { position: vec3(0, 0, 0) }, components: [], prefab: 'Stage End' }])
    const untouched = structuredClone(level)
    const report = newRefReport()

    expect(migrateLevelRefs(level, 'lv', [], TYPES, report)).toBe(false)
    expect(level, 'untouched until its file exists').toEqual(untouched)
    expect(report.created).toHaveLength(1)
    expect(report.created[0]).toMatchObject({ key: 'Stage End', name: 'Stage End' })
  })

  it('drops an entry nobody placed, once a file holds it', () => {
    const level = levelWith({ Trampoline: trampolineFile() }, [{ id: 'plain', transform: { position: vec3(0, 0, 0) }, components: [] }])
    const report = newRefReport()
    expect(migrateLevelRefs(level, 'lv', [file('aaa', 'Trampoline', trampolineFile())], TYPES, report)).toBe(true)
    expect(level.prefabs, 'nothing referenced, so nothing resolved').toEqual({})
    expect(report.dropped[0]!.why).toContain('no placements')
  })

  it('leaves a level with no table alone', () => {
    const level: Level = { id: 'lv', config: {}, nodes: [] }
    const report = newRefReport()
    expect(migrateLevelRefs(level, 'lv', [], TYPES, report)).toBe(true)
    expect(report).toEqual(newRefReport())
  })
})
