// @vitest-environment node
import { DEFAULT_REGISTRY } from '@mp/components'
import type { AssetEntry, Level, MaterialAsset, Node } from '@mp/content'
import { vec3 } from '@mp/core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { EDIT_ROUNDS, runTurn, type AssistantEvent, type Conversation } from '../../../editor-server/src/assistant/agent'
import { createBudget } from '../../../editor-server/src/assistant/budget'
import { DEFAULT_MODEL } from '../../../editor-server/src/assistant/models'
import { createRepoFiles } from '../../../editor-server/src/assistant/repoFiles'
import { claudeTalk, editorToolsOf, runOfAnswer } from '../../../editor-server/src/assistant/routes'
import { createToolRunner, TOOLS } from '../../../editor-server/src/assistant/tools'
import { createEditorActions, EDITOR_ACTIONS, type ActionHost } from '../actions'
import { levelDoc, type Doc } from '../editorDoc'
import { createHistoryStore } from '../historyStore'
import { toolsOf } from './editorLinkLocal'

/**
 * How well the assistant edits (ADR 0195): fixed prompts, each against a fresh small level, through the real agent
 * loop, the real model and the real editor actions — counted: model calls, tool calls, the calls refused, the cost.
 * A prompt passes when the level ends as asked.
 *
 * Calls the API and costs a little, so it runs only when asked:
 *   $env:ASSISTANT_EVAL='1'; $env:ANTHROPIC_API_KEY='…'; pnpm exec vitest run tools/editor/src/assistant/assistant.eval.test.ts
 */

const KEY = process.env.ASSISTANT_EVAL === '1' ? process.env.ANTHROPIC_API_KEY : undefined
const ROOT = join(__dirname, '../../../..')

const HAZARD = 'a1b2c3d4e5f60708'
const GRASS = '0f1e2d3c4b5a6978'
const TREE = '1122334455667788'

const STANDARD_PARAMS = [
  { key: 'color', label: 'colour', kind: 'color' },
  { key: 'metalness', label: 'metalness', kind: 'number', min: 0, max: 1 },
  { key: 'roughness', label: 'roughness', kind: 'number', min: 0, max: 1 },
] as const

/** A small level and its library: a box, a platform, a lamp, two coins; two materials and a model. */
const rig = () => {
  const lv: Level = { id: 'eval', config: {}, nodes: [] }
  const plain = levelDoc(lv, DEFAULT_REGISTRY)
  const name = (i: number, n: string): void => plain.setName(i, n)
  name(plain.placePrimitive('box', vec3(0, 0.5, 0), null), 'Box')
  name(plain.placePrimitive('platform', vec3(5, 0, 0), null), 'Platform')
  name(plain.placeEmpty(vec3(2, 3, 0), null), 'Lamp')
  name(plain.placeEmpty(vec3(-3, 1, 0), null), 'Coin')
  name(plain.placeEmpty(vec3(-4, 1, 0), null), 'Coin')

  const entries: AssetEntry[] = [
    { id: HAZARD, name: 'Hazard', kind: 'material', path: 'keyboard/materials/Hazard.mat.json' },
    { id: GRASS, name: 'Grass', kind: 'material', path: 'keyboard/materials/Grass.mat.json' },
    { id: TREE, name: 'Tree', kind: 'model', path: 'keyboard/models/Tree.glb' },
  ]
  const materials = new Map<string, MaterialAsset>([
    [HAZARD, { shader: 'standard', params: { color: { kind: 'color', value: '#ff4400' } } }],
    [GRASS, { shader: 'standard', params: { color: { kind: 'color', value: '#33aa33' } } }],
  ])

  let doc: Doc = plain
  const history = createHistoryStore({
    doc: () => doc,
    rootDoc: () => doc,
    rootLevel: () => lv,
    selection: () => [],
    selected: () => null,
    selectionRefs: () => [],
    selectionRoots: () => [],
    applySelection: () => {},
    deleteSelected: () => {},
    live: () => false,
    submit: () => {},
    rebuildViewport: () => {},
    repaint: () => {},
    loadNewReferencesThen: () => {},
    applyAsset: () => true,
    assetNow: (id) => materials.get(id),
    notify: { ok: () => {}, warn: () => {}, error: () => {} },
    renderStatus: () => {},
    refreshUi: () => {},
  })
  doc = history.withOps(plain)
  const host: ActionHost = {
    doc: () => doc,
    rootLevel: () => lv,
    history,
    repaint: () => {},
    heldBy: () => null,
    assetOpenBy: () => null,
    toPlace: async (id) => (entries.find((e) => e.id === id)?.kind === 'model' ? { kind: 'model' } : { refused: `${id} is not a prefab or a model` }),
    reframe: () => undefined,
    assetEntry: (id) => entries.find((e) => e.id === id),
    usableAssets: (kind) => entries.filter((e) => kind === undefined || e.kind === kind),
    assetRefusal: (of, id) => {
      const e = entries.find((x) => x.id === id)
      return e === undefined ? 'not in the project' : e.kind !== of ? `this takes a ${of}, not a ${e.kind}` : null
    },
    materialOf: (id) => materials.get(id),
    shaderParams: (shader) => (shader === 'standard' ? STANDARD_PARAMS : undefined),
    dataOf: () => undefined,
    dataTypeOf: () => undefined,
    editMaterial: (id, next) => void materials.set(id, next),
    editData: () => {},
    adoptable: () => [],
    select: () => {},
    frame: () => {},
    selection: () => [],
    where: () => ({ game: 'keyboard', level: 'keyboard/eval', prefab: null }),
    problems: () => [],
    screenshot: () => ({ mediaType: 'image/jpeg', data: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', width: 1, height: 1 }),
  }
  const byName = (n: string): Node | undefined => {
    const walk = (list: readonly Node[]): Node | undefined => {
      for (const x of list) {
        if (x.name === n) return x
        const inner = walk(x.children ?? [])
        if (inner !== undefined) return inner
      }
      return undefined
    }
    return walk(lv.nodes)
  }
  return { lv, actions: createEditorActions(host, EDITOR_ACTIONS), byName }
}

interface Case {
  readonly prompt: string
  readonly passed: (r: ReturnType<typeof rig>) => boolean
}

const CASES: readonly Case[] = [
  {
    prompt: 'Add a red sphere called Red Sphere that uses the Hazard material.',
    passed: ({ byName }) => {
      const r = byName('Red Sphere')?.components.find((c) => c.type === 'Renderer')
      return r?.params.model === 'builtin:sphere' && r.params.material === HAZARD
    },
  },
  { prompt: 'Rename Box to Crate and move it up by 2 metres.', passed: ({ byName }) => byName('Crate')?.transform.position.y === 2.5 },
  { prompt: 'Make the Platform twice as long along x.', passed: ({ byName }) => byName('Platform')?.transform.scale?.x === 6 },
  { prompt: 'Delete every object named Coin.', passed: ({ byName }) => byName('Coin') === undefined },
  { prompt: 'Put the Lamp under the Platform.', passed: ({ lv }) => lv.nodes.find((n) => n.name === 'Platform')?.children?.some((c) => c.name === 'Lamp') === true },
  { prompt: 'Make the Box a hazard.', passed: ({ byName }) => byName('Box')?.components.some((c) => c.type === 'Hazard') === true },
]

describe.skipIf(KEY === undefined)('the assistant editing, against the real model', () => {
  const talk = claudeTalk(KEY ?? '')
  const instructions = readFileSync(join(ROOT, 'ASSISTANT-EDIT.md'), 'utf8')
  const files = createRepoFiles(ROOT)
  const rows: string[] = []

  for (const c of CASES) {
    it(c.prompt, async () => {
      const r = rig()
      const editorTools = editorToolsOf(toolsOf(r.actions).map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })))
      const names = new Set(editorTools.map((t) => t.name))
      const serverTools = createToolRunner({ files, github: null, nextDraftId: () => 'd1' })
      const budget = createBudget({ file: null, limitOf: () => 5 })
      const turn = r.actions.startTurn('eval')
      let calls = 0
      let refused = 0
      const run = async (name: string, input: Record<string, unknown>) => {
        calls++
        const ran = names.has(name) ? runOfAnswer({ outcome: await r.actions.run(name, input, turn) }) : await serverTools(name, input)
        if (ran.isError === true) {
          refused++
          rows.push(`    refused ${name}: ${typeof ran.result === 'string' ? ran.result : '(blocks)'}`)
        }
        return ran
      }
      const conv: Conversation = { id: 'e', email: 'eval@x', name: 'Eval', title: '', mode: 'auto', model: DEFAULT_MODEL.id, createdAt: 0, messages: [], shown: [], drafts: new Map(), filed: new Map(), lastUsed: 0, busy: false, stopping: false }
      const events: AssistantEvent[] = []
      let rounds = 0
      await runTurn(
        conv,
        c.prompt,
        { game: 'keyboard', level: 'keyboard/eval' },
        {
          instructions,
          tools: [...TOOLS, ...editorTools],
          mode: 'auto',
          model: DEFAULT_MODEL,
          maxRounds: EDIT_ROUNDS,
          silent: (n) => names.has(n),
          talk: async (request, onText) => {
            rounds++
            return talk(request, onText)
          },
          run,
          budget,
        },
        (e) => events.push(e),
      )
      r.actions.endTurn(turn)
      const ok = c.passed(r)
      rows.unshift(`${ok ? 'PASS' : 'FAIL'}  ${c.prompt}\n      ${rounds} model calls, ${calls} tool calls, ${refused} refused, $${budget.spent('eval@x').toFixed(4)}`)
      console.log(rows.join('\n'))
      rows.length = 0
      expect(ok).toBe(true)
    }, 180_000)
  }
})
