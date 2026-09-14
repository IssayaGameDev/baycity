import { describe, expect, it } from 'vitest'

import { encodeSse, SSE_KEEPALIVE } from './sse'

describe('encodeSse', () => {
  it('frames an event with an id, one data line per line, and a blank line', () => {
    expect(encodeSse('ops', { seq: 3 }, 3)).toBe('id: 3\nevent: ops\ndata: {"seq":3}\n\n')
    expect(encodeSse('hello', { connId: 'c' })).toBe('event: hello\ndata: {"connId":"c"}\n\n')
  })
  it('a payload with a newline inside a string stays one JSON line; the keepalive is a comment', () => {
    expect(encodeSse('x', { s: 'a\nb' })).toBe('event: x\ndata: {"s":"a\\nb"}\n\n')
    expect(SSE_KEEPALIVE).toBe(':keepalive\n\n')
  })
})
