import { describe, expect, it } from 'vitest'

import { EDITOR_ACTIONS, type EditorActions } from '../actions'
import type { Turn } from '../historyStore'
import { remoteLink } from './editorLink'
import { answerLinks, describeCall, toolsOf } from './editorLinkLocal'

/**
 * The chat's link to the editor (ADR 0195): what the model is handed, how a change is said to the person, and a chat
 * tab of its own running the editor's actions in the editor tab that opened it — in a turn of its own.
 */

/** Editor actions that run nothing, and keep which turn each run was in. */
const fakeActions = () => {
  const runs: { name: string; turn: string | null }[] = []
  const ended: string[] = []
  const actions: EditorActions = {
    list: () => EDITOR_ACTIONS,
    run: async (name, _input, turn = null) => {
      runs.push({ name, turn: turn?.label ?? null })
      return { ok: true, result: null }
    },
    startTurn: (label): Turn => ({ label, steps: [], generation: 0 }),
    endTurn: (turn) => void ended.push(turn.label),
    nameOf: (id) => (id === 'n:a' ? 'Box' : null),
  }
  return { actions, runs, ended }
}

describe('what the model is handed', () => {
  it('is the reads and the edits, never what moves the person’s selection or camera', () => {
    const tools = toolsOf(fakeActions().actions)
    const names = tools.map((t) => t.name)
    expect(names).toContain('get_scene')
    expect(names).toContain('rename_object')
    expect(names).not.toContain('select_objects')
    expect(names).not.toContain('focus_objects')
    expect(tools.find((t) => t.name === 'rename_object')?.edits).toBe(true)
    expect(tools.find((t) => t.name === 'get_scene')?.edits).toBe(false)
  })
})

describe('a change in words', () => {
  const nameOf = (id: string): string | null => (id === 'n:a' ? 'Box' : null)
  it('names objects by their names, and says the rest as given', () => {
    expect(describeCall('rename_object', { id: 'n:a', name: 'Crate' }, nameOf)).toBe('Rename object — id: “Box”; name: Crate')
    expect(describeCall('set_transform', { id: 'n:a', position: { x: 1, y: 2, z: 0 } }, nameOf)).toBe('Set transform — id: “Box”; position: x 1, y 2, z 0')
  })
  it('says a read as what it looks at', () => {
    expect(describeCall('get_scene', {}, nameOf)).toBe('Looking at the scene')
    expect(describeCall('get_object', { id: 'n:a' }, nameOf)).toBe('Looking at “Box”')
  })
})

describe('a chat in a tab of its own', () => {
  it('runs the actions in the editor tab, in a turn of its own that ends as one', async () => {
    const { actions, runs, ended } = fakeActions()
    answerLinks('editor-1', () => actions)
    const link = remoteLink('editor-1')
    expect((await link.tools()).length).toBeGreaterThan(0)
    await link.begin('assistant: rename')
    expect(await link.run('rename_object', { id: 'n:a', name: 'Crate' })).toEqual({ ok: true, result: null })
    expect(await link.describe('rename_object', { id: 'n:a', name: 'Crate' })).toBe('Rename object — id: “Box”; name: Crate')
    await link.end()
    expect(runs).toEqual([{ name: 'rename_object', turn: 'assistant: rename' }])
    expect(ended).toEqual(['assistant: rename'])
  })

  it('says when no editor tab answers', async () => {
    const link = remoteLink('nobody')
    await expect(link.begin('x')).rejects.toThrow('the editor tab did not answer: is it still open?')
  }, 10_000)
})
