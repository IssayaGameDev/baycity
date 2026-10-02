import { parseRef, type EditorActions } from '../actions'
import type { Turn } from '../historyStore'
import { LINK_CHANNEL, type EditorLink, type EditorTool, type LinkAnswer, type LinkAsk } from './editorLink'

/**
 * The editor tab's side of the assistant's link (ADR 0195): its own chat's, straight to the actions, and the answers
 * to the chat tabs it opened. Here rather than in `editorLink.ts`, so a chat tab of its own does not load the editor.
 */

/**
 * The actions handed to the model: the reads and the edits. Not the ones that change the view — an agent never moves
 * the person's selection (Kodjo's call) nor their camera.
 */
export const toolsOf = (actions: EditorActions): EditorTool[] =>
  actions
    .list()
    .filter((a) => a.effect !== 'view')
    .map((a) => ({ name: a.name, description: a.summary, input_schema: a.input, edits: a.effect === 'edit' }))

/** A read, in the words the chat shows while it happens. */
const READS: Readonly<Record<string, string>> = {
  get_editor: 'Checking what is open',
  get_scene: 'Looking at the scene',
  get_object: 'Looking at',
  list_component_types: 'Looking at the component types',
  list_assets: 'Looking at the assets',
  get_asset: 'Looking at an asset',
  get_problems: 'Reading the editor’s warnings',
  screenshot_view: 'Looking at the viewport',
}

/** An action and what it changes, in words: objects by their names, the rest as given. */
export const describeCall = (name: string, input: unknown, nameOf: (id: string) => string | null): string => {
  const shown = (v: unknown): string => {
    if (typeof v === 'string') return parseRef(v) === null ? v : `“${nameOf(v) ?? v}”`
    if (Array.isArray(v)) return v.map(shown).join(', ')
    if (typeof v === 'object' && v !== null)
      return Object.entries(v)
        .map(([k, x]) => `${k} ${shown(x)}`)
        .join(', ')
    return String(v)
  }
  const fields = typeof input === 'object' && input !== null && !Array.isArray(input) ? Object.entries(input as Record<string, unknown>) : []
  const read = READS[name]
  if (read !== undefined) {
    const id = fields.find(([k]) => k === 'id')
    return id === undefined ? read : `${read} ${shown(id[1])}`
  }
  const what = name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
  return fields.length === 0 ? what : `${what} — ${fields.map(([k, v]) => `${k}: ${shown(v)}`).join('; ')}`
}

/** The link in the editor's own tab: straight to its actions, a turn of its own while a prompt runs. */
export const localLink = (actions: () => EditorActions | null): EditorLink => {
  let turn: Turn | null = null
  const need = (): EditorActions => {
    const a = actions()
    if (a === null) throw new Error('the editor is not ready')
    return a
  }
  return {
    tools: async () => toolsOf(need()),
    begin: async (label) => {
      const a = need()
      if (turn !== null) a.endTurn(turn)
      turn = a.startTurn(label)
    },
    run: async (name, input) => need().run(name, input, turn),
    describe: async (name, input) => {
      const a = need()
      return describeCall(name, input, a.nameOf)
    },
    end: async () => {
      if (turn !== null) need().endTurn(turn)
      turn = null
    },
  }
}

/** Answer the chat tabs this editor tab opened, each with a link of its own — so each prompt is its own undo. */
export const answerLinks = (tab: string, actions: () => EditorActions | null): void => {
  const channel = new BroadcastChannel(LINK_CHANNEL)
  const links = new Map<string, EditorLink>()
  channel.addEventListener('message', (e: MessageEvent<LinkAsk>) => {
    const d = e.data
    if (d?.kind !== 'ask' || d.tab !== tab || typeof d.from !== 'string') return
    let link = links.get(d.from)
    if (link === undefined) links.set(d.from, (link = localLink(actions)))
    const reply = (answer: Omit<LinkAnswer, 'kind' | 'to' | 'req'>): void => {
      const message: LinkAnswer = { kind: 'answer', to: d.from, req: d.req, ...answer }
      channel.postMessage(message)
    }
    const name = typeof d.name === 'string' ? d.name : ''
    const work: Promise<unknown> =
      d.op === 'tools' ? link.tools() : d.op === 'begin' ? link.begin(typeof d.label === 'string' ? d.label : 'assistant') : d.op === 'run' ? link.run(name, d.input) : d.op === 'describe' ? link.describe(name, d.input) : link.end()
    work.then(
      (value) => reply({ ok: true, value }),
      (err: unknown) => reply({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    )
  })
}
