import type { VisualItem } from '@mp/content'
import { describe, expect, it } from 'vitest'

import { assetIdsIn } from './assetRuntime'

const visual = (over: Partial<VisualItem>): VisualItem => ({
  collider: { kind: 'box', halfExtents: { x: 1, y: 1, z: 1 } },
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  scale: { x: 1, y: 1, z: 1 },
  model: undefined,
  material: undefined,
  visible: true,
  opacity: 1,
  fades: false,
  drawScale: { x: 1, y: 1, z: 1 },
  colliderHandles: [],
  ...over,
})

describe('assetIdsIn', () => {
  it('collects the files a draw list references, once each', () => {
    const ids = assetIdsIn([visual({ model: 'aaaaaaaaaaaaaaaa', material: 'mmmmmmmmmmmmmmmm' }), visual({ material: 'mmmmmmmmmmmmmmmm' })])
    expect(ids.sort()).toEqual(['aaaaaaaaaaaaaaaa', 'mmmmmmmmmmmmmmmm'])
  })

  it('leaves out a built-in shape: it is geometry this package builds, not a file to fetch (ADR 0090)', () => {
    expect(assetIdsIn([visual({ model: 'builtin:rounded-box', material: 'mmmmmmmmmmmmmmmm' })])).toEqual(['mmmmmmmmmmmmmmmm'])
    expect(assetIdsIn([visual({ model: 'builtin:sphere' })])).toEqual([])
  })
})
