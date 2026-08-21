import { isAnimationAsset, validateLevel, type ClipSource, type Level } from '@mp/content'
import { DEFAULT_REGISTRY } from '@mp/components'

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

export const ENTRIES: Entry[] = [{ name: 'level1', group: 'level', level: validateLevel(level1, DEFAULT_REGISTRY) }]

/**
 * Animation clips, keyed by asset id (ADR 0050).
 *
 * The viewer greyboxes everything and has no asset runtime, so it resolves no materials or models — but a
 * clip is not a surface, it is the motion, and motion is what this tool exists to look at. Ids come from the
 * `.meta` sidecars, the same way the game gets them.
 */
const CLIPS = import.meta.glob('../../../content/assets/**/*.anim.json', { eager: true, import: 'default' }) as Record<string, unknown>
const METAS = import.meta.glob('../../../content/assets/**/*.anim.json.meta', { eager: true, query: '?raw', import: 'default' }) as Record<
  string,
  string
>

const clipsById = new Map<string, unknown>()
for (const [metaKey, raw] of Object.entries(METAS)) {
  try {
    const id = (JSON.parse(raw) as { id?: unknown }).id
    const clip = CLIPS[metaKey.slice(0, -'.meta'.length)]
    if (typeof id === 'string' && id !== '' && clip !== undefined) clipsById.set(id, clip)
  } catch {
    // A corrupt sidecar is a clip the viewer does not know about, not a broken build.
  }
}

export const CLIP_SOURCE: ClipSource = {
  keys: (assetId) => {
    const clip = clipsById.get(assetId)
    return isAnimationAsset(clip) ? clip.keys : undefined
  },
}
