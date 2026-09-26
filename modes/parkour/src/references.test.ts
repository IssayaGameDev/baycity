import { isBuiltinModel, instantiateLevel, materialDependencies, nameForPath, validateLevel, type MaterialAsset } from '@mp/content'
import { PARKOUR_REGISTRY } from './rules'
import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { REPO_CONTENT } from '../../../content-root'
import { diskContent } from '../../../game-content'

/** Parkour's own levels and the assets it may use — its library and Shared's — as its page is served them (ADR 0169). */
const disk = diskContent(REPO_CONTENT, 'parkour')
const levels = {
  names: (): string[] => disk.index().levels,
  byName: (name: string) => validateLevel(disk.level(name), PARKOUR_REGISTRY),
}
const assets = disk.assets()
const materialOf = (id: string): MaterialAsset | undefined => {
  const json = disk.catalog().contentsOf(id)
  return typeof json === 'object' && json !== null && typeof (json as { shader?: unknown }).shader === 'string' ? (json as MaterialAsset) : undefined
}
const materials = [...assets].filter(([, e]) => e.kind === 'material')

/**
 * Every asset id in shipped content resolves.
 *
 * This guard arrived with ADR 0028, because that change altered what a broken visual reference *costs*. A
 * `style` was a name resolved against a table in the renderer: an unknown one fell back to a default colour
 * by design, so it was harmless. A material is an asset **id**, and a dangling id greyboxes silently — the
 * level still loads, still validates, still instantiates, and looks wrong.
 *
 * Ids survive renaming and moving, which is the point of the sidecars. What they cannot survive is the file
 * being deleted, so that is what this catches, over the assets the game's lists are made from.
 */
describe('content asset references', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it.each(levels.names())('every asset %s references exists', (name) => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: -30, z: 0 } })
    const loaded = instantiateLevel(world, levels.byName(name), PARKOUR_REGISTRY)

    // The loader has already applied instance overrides and flattened nesting, so its visuals are the
    // complete set of references — no walk of the level tree here to disagree with the one that matters.
    const dangling: string[] = []
    for (const v of loaded.visuals) {
      if (v.material !== undefined && !assets.has(v.material)) dangling.push(`material ${v.material}`)
      // A built-in shape is geometry the renderer builds, not a file to look up (ADR 0090).
      if (v.model !== undefined && !isBuiltinModel(v.model) && !assets.has(v.model)) dangling.push(`model ${v.model}`)
    }

    expect(dangling, `${name} references assets that are not in the database`).toEqual([])
    world.free()
  })

  it('every texture a material names exists', () => {
    const dangling: string[] = []
    for (const [id, entry] of materials) {
      const material = materialOf(id)
      if (material === undefined) {
        dangling.push(`${entry.path} did not parse as a material`)
        continue
      }
      for (const dep of materialDependencies(material)) {
        if (!assets.has(dep)) dangling.push(`${entry.path} → texture ${dep}`)
      }
    }
    expect(dangling).toEqual([])
  })

  // The seven keys the old STYLE_PALETTE held that content actually used are now material assets. Named
  // rather than counted: what matters is that the greybox language survived the migration by name, so a
  // level authored before ADR 0028 still looks like itself.
  it('ships the greybox palette as materials', () => {
    const byName = new Set(materials.map(([, e]) => nameForPath(e.path)))
    for (const key of ['ground', 'platform', 'ramp', 'moving', 'hazard', 'checkpoint', 'goal']) {
      expect(byName, `no material named ${key}`).toContain(key)
    }
  })
})
