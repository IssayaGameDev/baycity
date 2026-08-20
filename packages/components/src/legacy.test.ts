import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { createPhysicsWorld, initPhysics } from '@mp/physics'
import {
  COLLIDER,
  MATERIAL_OVERRIDE,
  TRACK,
  VISUAL,
  instantiateLegacyLevel,
  instantiateNodeLevel,
  validateLevel,
  validateNodeLevel,
  type ComponentData,
  type Level,
  type Node,
} from '@mp/content'
import type { Vec3 } from '@mp/core'
import { nodeLevelFromLegacy } from './legacy'
import { DEFAULT_REGISTRY } from './defaults'
import { Bumper, Checkpoint, Goal, Hazard } from './gameplay'

/**
 * The equivalence pass: every authored level, loaded both ways, must build the **same world**.
 *
 * This is the test the migration rests on. A schema change that is checked only by unit tests on fixtures
 * proves the fixtures were converted; running the real content through both loaders and comparing colliders,
 * visuals, markers, rules and poses-over-time is what proves the levels were.
 */

/**
 * The levels **as they were** before the migration, captured by `tools/migrate-to-components.ts`.
 *
 * The fixture rather than `content/levels/` because those files are nodes now — and because pinning the
 * legacy side keeps this test honest as Kodjo keeps editing levels: it proves the converter, not whatever
 * the editor last wrote. That the migrated files themselves load is covered by the mode's own
 * `levels.test.ts`.
 */
const LEGACY = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/legacy-content.json', import.meta.url)), 'utf8')) as Record<string, unknown>
const files = Object.keys(LEGACY)

const RULE_TYPE_TO_KIND: Record<string, string> = {
  [Checkpoint.type]: 'checkpoint',
  [Goal.type]: 'goal',
  [Hazard.type]: 'hazard',
  [Bumper.type]: 'bumper',
}

const readLevel = (file: string): Level => validateLevel(structuredClone(LEGACY[file]))

/** Rules as the mode sees them, from each loader, in creation order. */
const rulesOfLegacy = (triggers: readonly { kind: string; position: Vec3; power?: number }[]): unknown[] =>
  triggers.map((t) => ({ kind: t.kind, position: t.position, ...(t.kind === 'bumper' ? { power: t.power } : {}) }))

const rulesOfNodes = (nodes: readonly { components: readonly ComponentData[]; position: Vec3 }[]): unknown[] =>
  nodes.flatMap((n) =>
    n.components
      .filter((c) => c.type in RULE_TYPE_TO_KIND)
      .map((c) => ({
        kind: RULE_TYPE_TO_KIND[c.type],
        position: n.position,
        ...(c.type === Bumper.type ? { power: c.params.power } : {}),
      })),
  )

const posesOf = (visuals: readonly { position: Vec3; rotation: unknown }[]): unknown[] =>
  visuals.map((v) => ({ position: v.position, rotation: v.rotation }))

describe('a converted level builds the same world as the one it came from', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it('found the authored levels to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    describe(file, () => {
      const legacyLevel = readLevel(file)
      // Validating the *converted* level with the registry is half the point: it proves the converter emits
      // parameters that match every declaration, not merely JSON of the right shape.
      const nodeLevel = validateNodeLevel(nodeLevelFromLegacy(readLevel(file)), DEFAULT_REGISTRY)

      const load = (): { a: ReturnType<typeof instantiateLegacyLevel>; b: ReturnType<typeof instantiateNodeLevel> } => ({
        a: instantiateLegacyLevel(createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } }), legacyLevel),
        b: instantiateNodeLevel(createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } }), nodeLevel, DEFAULT_REGISTRY),
      })

      it('draws the same things, in the same order, with the same colliders and materials', () => {
        const { a, b } = load()
        expect(b.visuals).toEqual(a.visuals)
      })

      /**
       * Spawn only. The legacy loader also emitted `checkpoint` markers, which nothing has ever read — every
       * consumer filters for `spawn` — so they convert to inert nodes instead of world markers. See
       * `markerNode`.
       */
      it('places the same spawn', () => {
        const { a, b } = load()
        expect(b.markers).toEqual(a.markers.filter((m) => m.kind === 'spawn'))
      })

      it('exposes the same gameplay rules at the same positions', () => {
        const { a, b } = load()
        expect(rulesOfNodes(b.nodes)).toEqual(rulesOfLegacy(a.triggers))
      })

      // The wire index of a rider's movement base (ADR 0021) is a position in the dynamics list, so the
      // order that list is built in is not an implementation detail: a mismatch desyncs riders.
      it('numbers its clock-driven bodies identically', () => {
        const { a, b } = load()
        a.update(1234)
        b.update(1234)
        for (let i = 0; i < 64; i++) expect(b.basePoseOf(i, 'tick'), `dynamic ${i}`).toEqual(a.basePoseOf(i, 'tick'))
      })

      it('moves everything to the same pose at the same clock times', () => {
        const { a, b } = load()
        for (const t of [0, 250, 500, 1000, 2500, 4001, 7777]) {
          a.update(t)
          b.update(t)
          expect(posesOf(b.visuals), `t=${t}`).toEqual(posesOf(a.visuals))
        }
      })
    })
  }
})

const findNode = (level: { nodes: Node[]; prefabs?: Record<string, Node> }, id: string): Node | undefined => {
  const walk = (n: Node): Node | undefined => (n.id === id ? n : (n.children ?? []).map(walk).find((x) => x !== undefined))
  const roots = [...level.nodes, ...Object.values(level.prefabs ?? {})]
  return roots.map(walk).find((x) => x !== undefined)
}

const typesOf = (node: Node | undefined): string[] => (node?.components ?? []).map((c) => c.type)

describe('what each legacy field becomes', () => {
  const base: Level = {
    id: 'fx',
    config: { fallBehavior: 'respawn-checkpoint', fallY: -3 },
    prefabs: {
      pad: {
        id: 'pad',
        pieces: [
          { collider: { kind: 'box', halfExtents: { x: 1, y: 0.2, z: 1 } }, transform: { position: { x: 0, y: 0, z: 0 } }, id: 'padPiece', name: 'pad' },
        ],
      },
    },
    instances: [{ prefab: 'pad', transform: { position: { x: 0, y: 0, z: 0 } } }],
  }

  it('gives every piece a Collider and a Visual, since an omitted visual used to greybox', () => {
    const out = nodeLevelFromLegacy(base)
    expect(typesOf(findNode(out, 'padPiece'))).toEqual([COLLIDER, VISUAL])
  })

  it('keeps a piece id as its node id, so existing override keys still point at it', () => {
    const out = nodeLevelFromLegacy(base)
    expect(findNode(out, 'padPiece')).toBeDefined()
  })

  it('turns a trigger into its rule component, carrying the parameter', () => {
    const level = structuredClone(base)
    level.prefabs!.pad!.pieces[0]!.trigger = { kind: 'bumper', power: 40 }
    const node = findNode(nodeLevelFromLegacy(level), 'padPiece')
    expect(typesOf(node)).toContain(Bumper.type)
    expect(node?.components.find((c) => c.type === Bumper.type)?.params).toEqual({ power: 40 })
  })

  it('turns an instance material into a MaterialOverride the placement owns', () => {
    const level = structuredClone(base)
    level.instances[0]!.material = 'mat1'
    const out = nodeLevelFromLegacy(level)
    expect(typesOf(out.nodes[0])).toEqual([MATERIAL_OVERRIDE])
    expect(out.nodes[0]?.prefab).toBe('pad')
  })

  it('turns an instance behavior into a Track the placement owns, which beats the prefab as singleton', () => {
    const level = structuredClone(base)
    level.instances[0]!.behavior = { kind: 'track', keys: [{ t: 0 }, { t: 1000, position: { x: 0, y: 2, z: 0 } }] }
    expect(typesOf(nodeLevelFromLegacy(level).nodes[0])).toEqual([TRACK])
  })

  it('re-keys a piece override onto the node, patching the component that owned the field', () => {
    const level = structuredClone(base)
    level.instances[0]!.overrides = { padPiece: { material: 'mat2', transform: { position: { x: 5, y: 0, z: 0 } } } }
    const over = nodeLevelFromLegacy(level).nodes[0]?.overrides?.padPiece
    expect(over?.transform?.position).toEqual({ x: 5, y: 0, z: 0 })
    // The material lands on the Visual's own parameters, not on a field of the override.
    expect(Object.values(over?.params ?? {})).toEqual([{ material: 'mat2' }])
  })

  // The two sentinels ADR 0033 needed exist because absence meant "inherit". A component can simply be
  // gone, so they become removals — which is why `removed` is in the schema from C1 and not from C3.
  it('turns a cleared trigger into a removed component', () => {
    const level = structuredClone(base)
    level.prefabs!.pad!.pieces[0]!.trigger = { kind: 'hazard' }
    level.instances[0]!.overrides = { padPiece: { trigger: { kind: 'none' } } }
    const out = nodeLevelFromLegacy(level)
    const hazardId = findNode(out, 'padPiece')?.components.find((c) => c.type === Hazard.type)?.id
    expect(out.nodes[0]?.overrides?.padPiece?.removed).toEqual([hazardId])
  })

  it('swaps a rule for a different one by removing and adding', () => {
    const level = structuredClone(base)
    level.prefabs!.pad!.pieces[0]!.trigger = { kind: 'hazard' }
    level.instances[0]!.overrides = { padPiece: { trigger: { kind: 'bumper', power: 30 } } }
    const over = nodeLevelFromLegacy(level).nodes[0]?.overrides?.padPiece
    expect(over?.removed).toHaveLength(1)
    expect(over?.added?.map((c) => c.type)).toEqual([Bumper.type])
  })

  it('flattens an inline definition into plain nodes with nothing to reference', () => {
    const level: Level = {
      ...base,
      instances: [
        {
          prefab: { id: 'oneOff', pieces: [{ collider: { kind: 'ball', radius: 1 }, transform: { position: { x: 0, y: 0, z: 0 } }, id: 'ball' } ] },
          transform: { position: { x: 3, y: 0, z: 0 } },
        },
      ],
    }
    const out = nodeLevelFromLegacy(level)
    expect(out.nodes[0]?.prefab).toBeUndefined()
    expect(out.nodes[0]?.overrides).toBeUndefined()
    expect(typesOf(findNode(out, 'n0-ball'))).toEqual([COLLIDER, VISUAL])
  })

  it('bakes an inline definition’s overrides in, since there is nothing left to override against', () => {
    const level: Level = {
      ...base,
      instances: [
        {
          prefab: { id: 'oneOff', pieces: [{ collider: { kind: 'ball', radius: 1 }, transform: { position: { x: 0, y: 0, z: 0 } }, id: 'ball' }] },
          transform: { position: { x: 3, y: 0, z: 0 } },
          overrides: { ball: { transform: { position: { x: 0, y: 9, z: 0 } } } },
        },
      ],
    }
    const out = nodeLevelFromLegacy(level)
    expect(out.nodes[0]?.overrides).toBeUndefined()
    expect(findNode(out, 'n0-ball')?.transform.position).toEqual({ x: 0, y: 9, z: 0 })
  })

  it('names a prefab root by its table key, not by the id stored inside it', () => {
    const level = structuredClone(base)
    level.prefabs!.pad!.id = 'stale'
    expect(nodeLevelFromLegacy(level).prefabs?.pad?.name).toBe('pad')
  })

  it('validates against the registry, which a hand-built level does not get for free', () => {
    expect(() => validateNodeLevel(nodeLevelFromLegacy(base), DEFAULT_REGISTRY)).not.toThrow()
  })
})

describe('a marker that nothing read', () => {
  const level: Level = {
    id: 'fx',
    config: { fallBehavior: 'respawn-checkpoint', fallY: -3 },
    instances: [],
    markers: [
      { kind: 'spawn', transform: { position: { x: 0, y: 2, z: 0 } } },
      { kind: 'checkpoint', transform: { position: { x: 8, y: 1.5, z: 8 } }, radius: 1.5 },
    ],
  }

  it('keeps the spawn a spawn', () => {
    const out = nodeLevelFromLegacy(level)
    expect(typesOf(out.nodes[0])).toEqual(['Spawn'])
  })

  it('keeps a checkpoint marker’s position and radius, and leaves it switched off', () => {
    const node = nodeLevelFromLegacy(level).nodes[1]
    expect(node?.transform.position).toEqual({ x: 8, y: 1.5, z: 8 })
    expect(typesOf(node)).toEqual([COLLIDER, Checkpoint.type])
    expect(node?.components[0]?.params.shape).toEqual({ kind: 'ball', radius: 1.5 })
    expect(node?.components[0]?.enabled, 'inert, exactly as it was').toBe(false)
  })

  it('builds no body for it, so it is not something a mode can touch', () => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const loaded = instantiateNodeLevel(world, validateNodeLevel(nodeLevelFromLegacy(level), DEFAULT_REGISTRY), DEFAULT_REGISTRY)
    expect(loaded.nodes).toEqual([])
    expect(loaded.markers).toEqual([{ kind: 'spawn', position: { x: 0, y: 2, z: 0 } }])
  })
})
