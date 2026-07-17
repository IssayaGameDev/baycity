import type { Bytes, ClientTransport } from '@mp/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createNetsimClientTransport } from './index'

const makeInner = (): { transport: ClientTransport; sent: Bytes[]; emit: (d: Bytes) => void } => {
  let onMsg: ((d: Bytes) => void) | null = null
  const sent: Bytes[] = []
  return {
    transport: {
      send: (d) => sent.push(d),
      close: () => {},
      onOpen: () => {},
      onClose: () => {},
      onMessage: (h) => {
        onMsg = h
      },
    },
    sent,
    emit: (d) => onMsg?.(d),
  }
}

const buf = (): Bytes => new ArrayBuffer(4)

describe('netsim client transport', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('delays outgoing messages by the latency', () => {
    const inner = makeInner()
    const net = createNetsimClientTransport(inner.transport, { latencyMs: 100, jitterMs: 0, lossRate: 0 }, () => 0.5)
    net.send(buf())
    expect(inner.sent).toHaveLength(0) // not sent immediately
    vi.advanceTimersByTime(100)
    expect(inner.sent).toHaveLength(1)
  })

  it('delays incoming messages by the latency', () => {
    const inner = makeInner()
    const net = createNetsimClientTransport(inner.transport, { latencyMs: 80, jitterMs: 0, lossRate: 0 }, () => 0.5)
    const received: Bytes[] = []
    net.onMessage((d) => received.push(d))
    inner.emit(buf())
    expect(received).toHaveLength(0)
    vi.advanceTimersByTime(80)
    expect(received).toHaveLength(1)
  })

  it('drops messages according to the loss rate', () => {
    const inner = makeInner()
    // rng always 0 -> always < lossRate 0.5 -> always dropped
    const net = createNetsimClientTransport(inner.transport, { latencyMs: 10, jitterMs: 0, lossRate: 0.5 }, () => 0)
    net.send(buf())
    vi.advanceTimersByTime(1000)
    expect(inner.sent).toHaveLength(0)
  })

  it('exposes and updates conditions', () => {
    const inner = makeInner()
    const net = createNetsimClientTransport(inner.transport, { latencyMs: 10, jitterMs: 0, lossRate: 0 })
    expect(net.conditions().latencyMs).toBe(10)
    net.setConditions({ latencyMs: 50, jitterMs: 5, lossRate: 0.1 })
    expect(net.conditions().latencyMs).toBe(50)
  })
})
