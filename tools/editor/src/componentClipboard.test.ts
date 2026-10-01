import { describe, expect, it } from 'vitest'
import type { ParamDecls } from '@mp/components'

import { assetsRefusal, valuesRefusal, type Clip } from './componentClipboard'

/** What may be pasted where (ADR 0191), the half of copy and paste that needs no panel. */
describe('the component clipboard', () => {
  const bumper: Clip = { kind: 'component', type: 'Bumper', label: 'Bumper', params: { power: 40 }, enabled: true }

  it('pastes values only onto the same type, and only once something is copied', () => {
    expect(valuesRefusal(bumper, 'Bumper')).toBeNull()
    expect(valuesRefusal(bumper, 'Hazard')).toBe('the copy is a Bumper, and this is not one')
    expect(valuesRefusal(null, 'Bumper')).toMatch(/nothing copied/)
    expect(valuesRefusal({ kind: 'transform', position: { x: 0, y: 0, z: 0 }, rotationDeg: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, 'Bumper')).toMatch(/nothing copied/)
  })

  it('names the first asset field this document may not take, a list row’s included', () => {
    const decls: ParamDecls = {
      material: { kind: 'asset', of: 'material', default: '', label: 'material' },
      rows: { kind: 'list', default: [], label: 'rows', item: { tex: { kind: 'asset', of: 'material', default: '', label: 'skin' } } },
    }
    const refuse = (_of: string, id: string): string | null => (id === 'theirs' ? 'belongs to another game' : null)
    expect(assetsRefusal({ material: 'ours', rows: [] }, decls, refuse)).toBeNull()
    expect(assetsRefusal({ material: 'theirs' }, decls, refuse)).toBe('material: belongs to another game')
    expect(assetsRefusal({ material: '', rows: [{ tex: 'ours' }, { tex: 'theirs' }] }, decls, refuse)).toBe('rows › skin: belongs to another game')
  })
})
