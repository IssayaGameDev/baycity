import { validateLevel, type Level } from '@mp/content'

import level1 from '../../../content/levels/level1.json'

/**
 * The viewer's catalog: the level files in `content/levels/`.
 *
 * It used to list every kit maker on its own pad, which was the fastest way to look at a piece of geometry
 * when geometry only existed as code. The makers are gone (ADR 0027) and content is authored in the editor
 * now, which previews prefabs and models itself — so what is left worth inspecting here is whole levels.
 */
export interface Entry {
  name: string
  group: 'element' | 'level'
  level: Level
}

export const ENTRIES: Entry[] = [{ name: 'level1', group: 'level', level: validateLevel(level1) }]
