import type { Bytes, ClientTransport } from '@mp/core'

/**
 * @mp/netsim — network-condition simulation. Wraps a ClientTransport and
 * delays/drops messages in both directions, so netcode can be exercised under
 * latency/jitter/loss instead of localhost-perfect conditions (SEED §7, M4).
 * Headless: works in the browser demo and in Node bots/tests.
 */
export interface NetsimConditions {
  /** One-way base latency (ms), applied to each direction (RTT ≈ 2×). */
  latencyMs: number
  /** Uniform ± added to each delay (ms). */
  jitterMs: number
  /** Probability [0..1] that a message is dropped. */
  lossRate: number
}

export interface NetsimClientTransport extends ClientTransport {
  setConditions: (c: NetsimConditions) => void
  conditions: () => NetsimConditions
}

export const createNetsimClientTransport = (
  inner: ClientTransport,
  initial: NetsimConditions,
  rng: () => number = Math.random,
): NetsimClientTransport => {
  let cond = initial

  /** Delay for a message, or null if it is dropped. */
  const delayMs = (): number | null => {
    if (rng() < cond.lossRate) return null
    const jitter = (rng() * 2 - 1) * cond.jitterMs
    return Math.max(0, cond.latencyMs + jitter)
  }

  let messageHandler: ((data: Bytes) => void) | null = null
  inner.onMessage((data) => {
    const d = delayMs()
    if (d === null) return
    setTimeout(() => messageHandler?.(data), d)
  })

  return {
    send: (data) => {
      const d = delayMs()
      if (d === null) return
      setTimeout(() => inner.send(data), d)
    },
    close: () => inner.close(),
    onOpen: (h) => inner.onOpen(h),
    onClose: (h) => inner.onClose(h),
    onMessage: (h) => {
      messageHandler = h
    },
    setConditions: (c) => {
      cond = c
    },
    conditions: () => cond,
  }
}
