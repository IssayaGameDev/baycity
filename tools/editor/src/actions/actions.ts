import { ComponentError, type DataTypeDef } from '@mp/components'
import { applyOp, OpError, refKey, touchedRefs, type AssetEntry, type AssetKind, type DataAsset, type Level, type MaterialAsset, type Node, type NodeRef, type Op, type Transform } from '@mp/content'

import type { Doc, OpBatch } from '../editorDoc'
import type { HistoryStore, Turn } from '../historyStore'
import { InputError, type JsonSchema, type Schema } from './schema'

/**
 * The editor's actions (ADR 0194): what a person does in the editor, named and taking its input as data, so that an
 * agent can later be handed the same ones as tools — through the same document, the same checks, the same live room
 * and the same undo as the person's own clicks.
 *
 * An action that changes the document does it in `ctx.edit`, and that is where every rule lives, once:
 * - **One action, one batch.** What it changed goes to the room as one message, applied there all or nothing.
 * - **One prompt, one undo.** Run in a turn (an agent's), it is a step of the turn's one history entry; undoing that
 *   entry leaves what someone has changed since (`undoSteps.ts`). Run without one (a person's), it is an entry of its
 *   own, as a click is.
 * - **An agent stays off what someone else has selected** (Kodjo's call). In a turn, an edit touching a node another
 *   connection holds is taken back before anything is sent, and said; the person whose tab it is is not someone else.
 * - **All or nothing.** An action that fails half-way is taken back whole, and nothing of it is sent.
 *
 * Objects are named by their wire identity (`refKey`: `n:<id>`, a prefab's piece `t:<prefab>:<id>`, a placement's
 * piece `i:<placement>:<piece>`) — stable while others edit, unlike a position in the tree.
 */

/** An action refused: why, in words for whoever asked. */
export class ActionError extends Error {}

/** `read` changes nothing; `view` changes what this tab shows (its selection, its camera); `edit` changes the document. */
export type ActionEffect = 'read' | 'view' | 'edit'

export interface ActionDef<I> {
  /** The tool name an agent calls it by: snake_case, a verb first. */
  readonly name: string
  /** What it does, in the sentence an agent reads to choose it. */
  readonly summary: string
  readonly effect: ActionEffect
  readonly input: Schema<I>
  readonly run: (ctx: ActionCtx, input: I) => unknown
}

/** An action with its input type erased, as the list holds them. */
export interface Action {
  readonly name: string
  readonly summary: string
  readonly effect: ActionEffect
  /** Its input as JSON Schema: what a tool definition carries. */
  readonly input: JsonSchema
  readonly invoke: (ctx: ActionCtx, raw: unknown) => Promise<unknown>
}

export const defineAction = <I>(def: ActionDef<I>): Action => ({
  name: def.name,
  summary: def.summary,
  effect: def.effect,
  input: def.input.json,
  invoke: async (ctx, raw) => await def.run(ctx, def.input.parse(raw ?? {}, 'input')),
})

/** A shader's parameter, as the material Inspector draws it: what a material action may set. */
export interface ShaderParamInfo {
  readonly key: string
  readonly label: string
  readonly kind: MaterialAsset['params'][string]['kind']
  readonly min?: number
  readonly max?: number
}

/** A prefab or model ready to place, or why it cannot go into the open document. */
export type Placeable = { readonly kind: 'prefab'; readonly root: Node } | { readonly kind: 'model' } | { readonly refused: string }

/** What the actions need from the editor around them. Getters, so nothing here holds a stale document. */
export interface ActionHost {
  /** The document being edited: the level, or a prefab open on top of it. */
  readonly doc: () => Doc | null
  /** The level every op applies to: the file's. */
  readonly rootLevel: () => Level | null
  readonly history: HistoryStore
  /** Redraw after ops changed the level outside a gesture, as an undo or a teammate's edit is. */
  readonly repaint: (ops: readonly Op[]) => void
  /** Another connection holding one of these nodes, by its person's name; never this tab. */
  readonly heldBy: (refs: readonly NodeRef[]) => { readonly name: string; readonly ref: NodeRef } | null
  /** Who else has this asset open in their Inspector, by name; never this tab. */
  readonly assetOpenBy: (assetId: string) => string | null
  /** A prefab (fetched as it is now) or a model ready to place here, or why not — the Project window's checks. */
  readonly toPlace: (assetId: string) => Promise<Placeable>
  /** Node `i`'s local transform under `parent`, keeping where it is in the world — what the Hierarchy's drag writes. */
  readonly reframe: (i: number, parent: number | null) => Transform | undefined
  readonly assetEntry: (assetId: string) => AssetEntry | undefined
  /** Assets the open document may use (ADR 0161), of a kind or all. */
  readonly usableAssets: (kind?: AssetKind) => readonly AssetEntry[]
  /** Why an asset field may not take this asset, or `null`: the Inspector's own refusal. */
  readonly assetRefusal: (of: AssetKind, assetId: string, dataType: string | undefined) => string | null
  readonly materialOf: (assetId: string) => MaterialAsset | undefined
  readonly shaderParams: (shader: string) => readonly ShaderParamInfo[] | undefined
  readonly dataOf: (assetId: string) => DataAsset | undefined
  /** The data type a data asset is read against: its game's declaration, or `undefined`. */
  readonly dataTypeOf: (assetId: string) => DataTypeDef | undefined
  /** Edit a material or a data asset the Inspector's way: ops on its live document, recorded as `turn`'s or as an entry. */
  readonly editMaterial: (assetId: string, next: MaterialAsset, label: string, turn: Turn | null) => void
  readonly editData: (assetId: string, next: DataAsset, label: string, turn: Turn | null) => void
  /** Shared components the open game has not added: named when one is asked for, never added by an action. */
  readonly adoptable: () => readonly string[]
  readonly select: (indices: readonly number[]) => void
  readonly frame: (indices: readonly number[]) => void
  readonly selection: () => readonly number[]
  /** What is open: the game, the level, a prefab on top. */
  readonly where: () => { readonly game: string | null; readonly level: string | null; readonly prefab: string | null }
  /** The latest warnings and errors this tab has shown, oldest first. */
  readonly problems: () => readonly string[]
  /** The viewport as this tab shows it, small; `null` while Play runs or the viewport has no size. */
  readonly screenshot: () => Screenshot | null
}

/** A picture of the viewport: a JPEG, base64, and its size in pixels. */
export interface Screenshot {
  readonly mediaType: 'image/jpeg'
  readonly data: string
  readonly width: number
  readonly height: number
}

/** What an action is handed. */
export interface ActionCtx {
  readonly host: ActionHost
  /** The turn this runs in — an agent's prompt — or `null` for a person's own. */
  readonly turn: Turn | null
  /** The open document; refused when none is. */
  readonly doc: () => Doc
  /** Where the object with this id is now; refused when it is gone. */
  readonly at: (id: string) => number
  /** The id of the object at `i`. */
  readonly idAt: (i: number) => string
  /**
   * Change the document as one undoable edit: `change`'s ops held, checked against others' holds in a turn, then sent
   * as one batch and recorded — or all taken back if it throws or is refused.
   */
  readonly edit: <T>(label: string, change: (doc: Doc) => T) => T
}

/** What a run of an action came to: its result, or why it did not happen. */
export type ActionOutcome = { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: string }

export interface EditorActions {
  readonly list: () => readonly Action[]
  /** Run one by name. `turn` for an agent's prompt; absent, the person's own. */
  readonly run: (name: string, input: unknown, turn?: Turn | null) => Promise<ActionOutcome>
  /** An agent's prompt begins: what its actions change gathers as one undo entry, made when it ends. */
  readonly startTurn: (label: string) => Turn
  readonly endTurn: (turn: Turn) => void
  /** The name the Hierarchy shows for the object with this id, or `null` when there is none. */
  readonly nameOf: (id: string) => string | null
}

/** A `refKey` read back: `n:<id>`, `t:<table>:<id>`, `i:<owner>:<node>`. `null` for anything else. */
export const parseRef = (id: string): NodeRef | null => {
  const parts = id.split(':')
  if (parts.some((p) => p === '')) return null
  if (parts[0] === 'n' && parts.length === 2) return { id: parts[1]! }
  if (parts[0] === 't' && parts.length === 3) return { table: parts[1]!, id: parts[2]! }
  if (parts[0] === 'i' && parts.length === 3) return { owner: parts[1]!, node: parts[2]! }
  return null
}

/** Who else holds a node these ops touch, walking them over a copy of the level as it was: a removal names its subtree. */
const heldIn = (host: ActionHost, before: Level, ops: readonly Op[]): { name: string; ref: NodeRef } | null => {
  for (const op of ops) {
    const holder = host.heldBy(touchedRefs(before, op))
    if (holder !== null) return holder
    try {
      applyOp(before, op)
    } catch (e) {
      if (!(e instanceof OpError)) throw e
    }
  }
  return null
}

export const createEditorActions = (host: ActionHost, actions: readonly Action[]): EditorActions => {
  const byName = new Map(actions.map((a) => [a.name, a]))

  const ctxFor = (action: Action, turn: Turn | null): ActionCtx => {
    const doc = (): Doc => {
      const d = host.doc()
      if (d === null) throw new ActionError('no level or prefab is open')
      return d
    }
    const at = (id: string): number => {
      const ref = parseRef(id)
      if (ref === null) throw new ActionError(`'${id}' is not an object id: ids look like n:1a2b3c4d`)
      const i = doc().indexOfRef(ref)
      if (i === null) throw new ActionError(`no object ${id} here: it may have been deleted — read the scene again`)
      return i
    }
    const idAt = (i: number): string => {
      const ref = doc().refAt(i)
      if (ref === null) throw new ActionError(`no object at ${i}`)
      return refKey(ref)
    }
    const edit = <T,>(label: string, change: (d: Doc) => T): T => {
      if (action.effect !== 'edit') throw new Error(`${action.name} is declared ${action.effect} and cannot edit`)
      const d = doc()
      const level = host.rootLevel()
      if (level === null) throw new ActionError('no level is open')
      const before = turn === null ? null : structuredClone(level)
      const batches: OpBatch[] = []
      const takeBack = (): void => {
        const undone = host.history.discardHeldBatches(batches)
        if (undone.length > 0) host.repaint(undone)
      }
      let value: T
      try {
        value = host.history.holding(batches, () => change(d))
      } catch (e) {
        takeBack()
        throw e
      }
      const ops = batches.flatMap((b) => b.ops)
      const holder = before === null ? null : heldIn(host, before, ops)
      if (holder !== null) {
        takeBack()
        const i = d.indexOfRef(holder.ref)
        throw new ActionError(`${holder.name} has ${i === null ? 'it' : `“${d.label(i)}”`} selected, so it was left alone`)
      }
      host.history.commitHeld(batches, label, turn)
      if (ops.length > 0) host.repaint(ops)
      return value
    }
    return { host, turn, doc, at, idAt, edit }
  }

  return {
    list: () => actions,
    startTurn: (label) => host.history.startTurn(label),
    endTurn: (turn) => host.history.endTurn(turn),
    nameOf: (id) => {
      const ref = parseRef(id)
      const d = host.doc()
      const i = ref === null || d === null ? null : d.indexOfRef(ref)
      return i === null || d === null ? null : d.label(i)
    },
    run: async (name, input, turn = null) => {
      const action = byName.get(name)
      if (action === undefined) return { ok: false, error: `no action '${name}'` }
      try {
        return { ok: true, result: (await action.invoke(ctxFor(action, turn), input)) ?? null }
      } catch (e) {
        const known = e instanceof ActionError || e instanceof InputError || e instanceof ComponentError || e instanceof OpError
        return { ok: false, error: known ? e.message : `${name} failed: ${e instanceof Error ? e.message : String(e)}` }
      }
    },
  }
}
