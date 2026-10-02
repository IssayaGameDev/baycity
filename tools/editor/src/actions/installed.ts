import type { EditorActions } from './actions'

/**
 * The open editor's actions, once `main.ts` has built them over its own document, history and room (ADR 0194): one
 * set per tab, for whatever runs them.
 */
let installed: EditorActions | null = null

export const installEditorActions = (actions: EditorActions): void => {
  installed = actions
}

export const editorActions = (): EditorActions | null => installed
