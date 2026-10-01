import { describe, expect, it } from 'vitest'

import { TEXT } from './nodes'
import { textFontRefusal, textOf } from './text'

/** A `Text` component, read (ADR 0189): one reading for the loader and the editor. */
describe('reading a Text', () => {
  const text = (params: Record<string, unknown>, enabled?: boolean) => [{ id: 't', type: TEXT, params, ...(enabled === undefined ? {} : { enabled }) }]

  it('fills what is unset with the component’s defaults', () => {
    expect(textOf(text({}))).toEqual({ text: 'Text', font: '', size: 0.5, color: '#ffffff', align: 'center', width: 0, bold: false, facing: 'object', back: 'mirrored' })
  })

  it('reads what is set', () => {
    const read = textOf(text({ text: 'Hello\nthere', font: 'f1', size: 2, color: '#ff0000', align: 'left', width: 6, bold: true, facing: 'camera', back: 'hidden' }))
    expect(read).toEqual({ text: 'Hello\nthere', font: 'f1', size: 2, color: '#ff0000', align: 'left', width: 6, bold: true, facing: 'camera', back: 'hidden' })
  })

  /** The text library reads TrueType, OpenType and WOFF; a woff2 is refused with what to do about it (ADR 0190). */
  it('takes a ttf, otf or woff font, and refuses a woff2', () => {
    for (const path of ['Shared/fonts/a.ttf', 'Shared/fonts/b.OTF', 'Shared/fonts/c.woff']) expect(textFontRefusal(path), path).toBeNull()
    expect(textFontRefusal('Shared/fonts/d.woff2')).toMatch(/convert it to woff, ttf or otf/)
  })

  it('falls back on what it cannot use', () => {
    const read = textOf(text({ align: 'middle', facing: 'up', back: 'see-through', size: -3, width: -1 }))!
    expect([read.align, read.facing, read.back]).toEqual(['center', 'object', 'mirrored'])
    expect(read.size).toBeGreaterThan(0)
    expect(read.width).toBe(0)
  })

  it('is nothing on a node without one, or with it switched off', () => {
    expect(textOf([])).toBeUndefined()
    expect(textOf(text({ text: 'off' }, false))).toBeUndefined()
  })
})
