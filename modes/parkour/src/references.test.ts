import { instantiateNodeLevel, materialDependencies } from '@mp/content'
import { DEFAULT_REGISTRY } from '@mp/components'
import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { ASSET_DB, materialOf } from './assets'
import { levelByName, levelNames } from './levels'

/**
 * Every asset id in shipped content resolves.
 *
 * This guard arrived with ADR 0028, because that change altered what a broken visual reference *costs*. A
 * `style` was a name resolved against a table in the renderer: an unknown one fell back to a default colour
 * by design, so it was harmless. A material is an asset **id**, and a dangling id greyboxes silently — the
 * level still loads, still validates, still instantiates, and looks wrong.
 *
 * Ids survive renaming and moving, which is the point of the sidecars. What they cannot survive is the file
 * being deleted, so that is what this catches, over the same database the game resolves against.
 */
describe('content asset references', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it.each(levelNames())('every asset %s references exists', (name) => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: -30, z: 0 } })
    const loaded = instantiateNodeLevel(world, levelByName(name), DEFAULT_REGISTRY)

    // The loader has already applied instance overrides and flattened nesting, so its visuals are the
    // complete set of references — no walk of the level tree here to disagree with the one that matters.
    const dangling: string[] = []
    for (const v of loaded.visuals) {
      if (v.material !== undefined && ASSET_DB.byId[v.material] === undefined) dangling.push(`material ${v.material}`)
      if (v.model !== undefined && ASSET_DB.byId[v.model] === undefined) dangling.push(`model ${v.model}`)
    }

    expect(dangling, `${name} references assets that are not in the database`).toEqual([])
    world.free()
  })

  it('every texture a material names exists', () => {
    const dangling: string[] = []
    for (const entry of ASSET_DB.entries.filter((e) => e.kind === 'material')) {
      const material = materialOf(entry.id)
      if (material === undefined) {
        dangling.push(`${entry.path} did not parse as a material`)
        continue
      }
      for (const dep of materialDependencies(material)) {
        if (ASSET_DB.byId[dep] === undefined) dangling.push(`${entry.path} → texture ${dep}`)
      }
    }
    expect(dangling).toEqual([])
  })

  // The seven keys the old STYLE_PALETTE held that content actually used are now material assets. Named
  // rather than counted: what matters is that the greybox language survived the migration by name, so a
  // level authored before ADR 0028 still looks like itself.
  it('ships the greybox palette as materials', () => {
    const byName = new Set(ASSET_DB.entries.filter((e) => e.kind === 'material').map((e) => e.name))
    for (const key of ['ground', 'platform', 'ramp', 'moving', 'hazard', 'checkpoint', 'goal']) {
      expect(byName, `no material named ${key}`).toContain(key)
    }
  })
})
