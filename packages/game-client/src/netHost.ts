import { createClockSync, createSnapshotClient, createSnapshotReassembler } from '@mp/client'
import type { EntityId } from '@mp/core'
import {
  decodePong,
  decodeRoster,
  decodeSnapshot,
  decodeWelcome,
  encodePing,
  encodeState,
  MSG_PONG,
  MSG_ROSTER,
  MSG_SNAPSHOT,
  MSG_WELCOME,
  NET_CHANNEL,
  QUANT_BOUND,
  readMessageType,
  type PlayerState,
  type SnapshotEntity,
} from '@mp/net'
import { Client, type Room } from 'colyseus.js'

import type { StatusLine } from './status'
import { relayUrl } from './relayUrl'

/**
 * The room, the clock and the snapshot stream (ADR 0013, ADR 0065).
 *
 * This is the part of a client that genuinely must be uniform: every client in a room has to agree on the wire
 * format and on what time it is, or nobody sees anybody in the right place. It is therefore the platform's,
 * and it is the reason `startGameClient` is being taken apart rather than deleted.
 *
 * Nothing here knows what a game is. It carries a game *name* and a level name, and only as the two
 * matchmaking filters.
 */
export interface NetHost {
  /** Our own id, once the server has assigned one. `null` until then, which is most of the first second. */
  id: () => EntityId | null
  /** Every peer as of now, on the delayed timeline. Never includes us — the server does not relay us back. */
  sample: () => readonly SnapshotEntity[]
  /** A peer's display name, or undefined before the first roster. */
  nameOf: (id: EntityId) => string | undefined
  /** Everyone the server has named, us included — what the pause screen's player list is built from. */
  roster: () => readonly { id: EntityId; name: string }[]
  /** Our own display name, which is what peers see above our head. */
  readonly myName: string
  /** Our position, and everything about us a viewer cannot derive from it (v8/v9/v10). */
  send: (state: PlayerState) => void
  /** The server's clock, slewed. What every clock-driven piece in the level is posed against. */
  serverNow: () => number
  /** Leave the room and stop pinging it. */
  dispose: () => void
}

export interface NetHostOptions {
  /**
   * The two matchmaking filters (server: `.filterBy(['game', 'level'])`), so a room only ever holds players in
   * the same game on the same level. One room type serves every game on the platform; which game it is is a
   * filter, not a room name (ADR 0052).
   */
  game: string
  level: string
  /**
   * The level's `netBounds` (ADR 0093), sent with the join so the room can adopt it.
   *
   * Only the **first** client into a room sets it; everyone after is told the room's value in `WELCOME` and
   * uses that, even if their own level file disagrees. Undefined means "no opinion, use the default".
   */
  bounds?: number | undefined
  /**
   * Told once, when the server assigns our id.
   *
   * This is the cue to build the local sim, and it is a callback rather than a promise because the render loop
   * starts before the room is joined and has to cope with there being no world yet (ADR 0055).
   */
  onWelcome: (id: EntityId) => void
  setStatus: StatusLine['set']
}

/** How often we ask the server what time it is. */
const PING_INTERVAL_MS = 250
/** How far behind the newest snapshot peers are drawn, to have two to interpolate between. */
const INTERPOLATION_DELAY_MS = 100

/** Auto-assigned display names (player-chosen ones come later — ADR 0013). */
const ADJ = ['Swift', 'Brave', 'Calm', 'Lucky', 'Sly', 'Bold', 'Keen', 'Wily']
const NOUN = ['Fox', 'Otter', 'Hawk', 'Wolf', 'Lynx', 'Crow', 'Bear', 'Mole']
const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)]!

/** Relay endpoint: `relayUrl` over the page's location (ADR 0085). */
const serverUrl = (): string => relayUrl(location)

/** Colyseus `onMessage` hands us a `Uint8Array` view; our codecs take a standalone `ArrayBuffer`. */
const toArrayBuffer = (m: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(m.byteLength)
  copy.set(m)
  return copy.buffer
}

/**
 * Joins a room and starts listening. **Synchronous**, with the join in flight: the caller renders immediately
 * and `id()` stays `null` until the welcome arrives, exactly as it did inline.
 *
 * `joinOrCreate` fills the most-full non-full room and spins up a new one otherwise — auto-join, no
 * matchmaking UI (ADR 0013). A raw WebSocket will not do: the SDK performs the HTTP seat reservation and then
 * upgrades.
 */
export const createNetHost = ({ game, level, bounds, onWelcome, setStatus }: NetHostOptions): NetHost => {
  const clock = createClockSync()
  const reassembler = createSnapshotReassembler()
  const interp = createSnapshotClient({ interpolationDelayMs: INTERPOLATION_DELAY_MS, serverNow: () => clock.serverNow() })

  const myName = `${pick(ADJ)} ${pick(NOUN)}`
  const names = new Map<EntityId, string>()
  let myId: EntityId | null = null
  /**
   * The room's quantization bound, from `WELCOME`. `WELCOME` is sent inside `onJoin`, before the room's first
   * tick can reach us, so a snapshot decoded at the default would be a bug rather than a race — the fallback
   * is here so a lost welcome degrades to slightly wrong positions instead of a crash.
   */
  let bound: number = QUANT_BOUND
  let room: Room | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null

  const onNet = (m: Uint8Array): void => {
    const buf = toArrayBuffer(m)
    switch (readMessageType(buf)) {
      case MSG_WELCOME: {
        const welcome = decodeWelcome(buf)
        bound = welcome.bound
        myId = welcome.playerId
        onWelcome(myId)
        break
      }
      case MSG_SNAPSHOT:
        // Peers only (the server never relays our own body back to us); interpolate.
        interp.ingest(reassembler.apply(decodeSnapshot(buf, bound)))
        break
      case MSG_ROSTER:
        names.clear()
        for (const e of decodeRoster(buf)) names.set(e.id, e.name)
        break
      case MSG_PONG: {
        const pong = decodePong(buf)
        clock.recordSample(pong.clientTimeMs, pong.serverTimeMs, performance.now())
        break
      }
    }
  }

  const connect = async (): Promise<void> => {
    try {
      room = await new Client(serverUrl()).joinOrCreate('game', { name: myName, game, level, ...(bounds !== undefined ? { bounds } : {}) })
    } catch {
      setStatus('status.offline')
      return
    }
    setStatus('status.room', { room: room.roomId })
    room.onMessage(NET_CHANNEL, onNet)
    room.onLeave(() => {
      setStatus('status.offline')
    })
    pingTimer = setInterval(
      () => room?.sendBytes(NET_CHANNEL, new Uint8Array(encodePing({ clientTimeMs: performance.now() }))),
      PING_INTERVAL_MS,
    )
  }
  void connect()

  return {
    myName,
    id: () => myId,
    sample: () => interp.sample(),
    nameOf: (id) => names.get(id),
    roster: () => [...names].map(([id, name]) => ({ id, name })),
    serverNow: () => clock.serverNow(),
    send: (state) => {
      room?.sendBytes(NET_CHANNEL, new Uint8Array(encodeState(state)))
    },
    dispose: () => {
      if (pingTimer !== null) clearInterval(pingTimer)
      pingTimer = null
      void room?.leave()
      room = null
    },
  }
}
