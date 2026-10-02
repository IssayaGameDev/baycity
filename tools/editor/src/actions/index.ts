import type { Action } from './actions'
import { EDIT_ACTIONS } from './editActions'
import { READ_ACTIONS, VIEW_ACTIONS } from './readActions'

export { ActionError, createEditorActions, defineAction, parseRef } from './actions'
export { editorActions, installEditorActions } from './installed'
export type { Action, ActionCtx, ActionEffect, ActionHost, ActionOutcome, EditorActions, Placeable, Screenshot, ShaderParamInfo } from './actions'

/** Every editor action (ADR 0194): the reads, what changes the view, and the edits. */
export const EDITOR_ACTIONS: readonly Action[] = [...READ_ACTIONS, ...VIEW_ACTIONS, ...EDIT_ACTIONS]
