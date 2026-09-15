import { validateLevel, type Level } from '@mp/content'
import type { ModeDescriptor } from '@mp/mode'
import { PARKOUR_MODE } from '@mode/parkour/editorMode'

import level1 from '@content/levels/level1.json'

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
  /**
   * The game this entry's level belongs to (ADR 0052) — where its components, rule colours and character
   * tuning come from.
   *
   * Named at the entry rather than looked up, because this catalog is a hand-written list of one: an explicit
   * field says which game a line is for without the viewer needing to install every game to find out.
   */
  mode: ModeDescriptor
}

export const ENTRIES: Entry[] = [
  { name: 'level1', group: 'level', level: validateLevel(level1, PARKOUR_MODE.registry), mode: PARKOUR_MODE },
]

