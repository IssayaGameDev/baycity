import { Room, type Client } from 'colyseus'
import { entityId, type EntityId } from '@mp/core'
import {
  decodePing,
  decodeState,
  encodePong,
  encodeRoster,
  encodeSnapshot,
  encodeWelcome,
  MSG_PING,
  MSG_STATE,
  boundOf,
  NET_CHANNEL,
  quantizeAxis,
  QUANT_BOUND,
  quantizeSpeed,
  quantizeYaw,
  readMessageType,
  type PlayerState,
  type RosterEntry,
  type SnapshotEntity,
  type SnapshotMessage,
} from '@mp/net'

export const SNAPSHOT_RATE_HZ = 20 // SEED §2: 15–20 Hz; upper end within the locked range
const FIRST_PLAYER_ID = 1000 // ids for relayed players (server assigns; content-free)

interface Player {
  readonly client: Client
  readonly id: EntityId
  readonly name: string // display name (auto-random now, player-chosen later)
  latest: PlayerState | null // last state this client reported (it owns its own body)
  sentFull: boolean
  baseline: Map<EntityId, PlayerState> // last states sent to this client (for delta)
}

// Relay an entity when anything a viewer will actually receive changes: its quantized position, its
// state flags, or its quantized facing/speed. A player can turn on the spot, or leave the ground,
// without their quantized position moving at all — and those are exactly the things a viewer cannot
// reconstruct (see STATE_GROUNDED, PlayerState.yaw).
//
// Compared *quantized*, not raw: the wire only carries the quantized value, so comparing floats would
// relay an entity every tick for a change the recipient could never see, which is the delta's whole job.
const relayDiffers = (a: PlayerState, b: PlayerState, bound: number): boolean =>
  a.flags !== b.flags ||
  quantizeAxis(a.position.x, bound) !== quantizeAxis(b.position.x, bound) ||
  quantizeAxis(a.position.y, bound) !== quantizeAxis(b.position.y, bound) ||
  quantizeAxis(a.position.z, bound) !== quantizeAxis(b.position.z, bound) ||
  quantizeYaw(a.yaw) !== quantizeYaw(b.yaw) ||
  quantizeSpeed(a.speed) !== quantizeSpeed(b.speed) ||
  // Stepping onto or off a platform changes the *frame* the position is expressed in, so it has to
  // reach every viewer on the tick it happens even if nothing else moved (v10, ADR 0021).
  a.base !== b.base ||
  // A teleport: a viewer must stop blending at it, even onto a spot the same quantized position as before (ADR 0214).
  a.teleports !== b.teleports

// Colyseus hands us a Uint8Array view (possibly onto a pooled/shared buffer); our
// codecs take a standalone ArrayBuffer, so copy the exact bytes out.
const toArrayBuffer = (b: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(b.byteLength)
  copy.set(b)
  return copy.buffer
}
const bytes = (b: ArrayBuffer): Uint8Array => new Uint8Array(b)

// --- budget-3 tick stats, aggregated across rooms in this process (load harness reads it) ---
let statTicks = 0
let statSumMs = 0
let statMaxMs = 0
export const getRoomStats = (): { ticks: number; tickAvgMs: number; tickMaxMs: number } => ({
  ticks: statTicks,
  tickAvgMs: statTicks > 0 ? statSumMs / statTicks : 0,
  tickMaxMs: statMaxMs,
})
export const resetRoomStats = (): void => {
  statTicks = 0
  statSumMs = 0
  statMaxMs = 0
}

/**
 * Client-authoritative persistent-world room (ADR 0011/0013). Colyseus owns the
 * transport + lifecycle + matchmaking; this room owns no simulation. Each client
 * simulates its own entity and sends STATE; the room stores the latest and relays
 * peers' positions as per-client delta snapshots on its own clock-synced timeline.
 * No `@colyseus/schema` — our binary protocol is the payload.
 *
 * **One room type for every game on the platform** (ADR 0052). It was `ParkourRoom`,
 * which was only ever a name: nothing in here is parkour, or is any game at all — it
 * relays bytes and never learns what a level is. Which game a room belongs to is a
 * matchmaking filter, not a subclass.
 */
export class GameRoom extends Room {
  override maxClients = 20
  private readonly players = new Map<Client, Player>()
  private nextPlayerId = FIRST_PLAYER_ID
  private serverTimeMs = 0
  /**
   * How far this room's level reaches, for quantization (ADR 0093). Set by the first client to arrive and
   * never changed after, then handed to everyone else in `WELCOME`.
   *
   * The relay still never reads a level (ADR 0052): it is told a number, not shown a file. First-one-wins
   * rather than last, because changing it mid-room would silently move every peer already on screen — and a
   * room only ever holds one game on one level anyway (`filterBy(['game', 'level'])`), so the clients after
   * the first are sending the same value unless one of them is running stale content.
   */
  private bound: number | null = null

  override onCreate(): void {
    this.setPatchRate(null) // no @colyseus/schema state to sync
    // Client `sendBytes(NET_CHANNEL, ...)` arrives here as raw bytes (0.16 routes
    // ROOM_DATA_BYTES through the normal onMessage handler).
    this.onMessage(NET_CHANNEL, (client: Client, data: Uint8Array) => this.onNet(client, data))
    this.setSimulationInterval((dtMs) => this.tick(dtMs), 1000 / SNAPSHOT_RATE_HZ)
  }

  override onJoin(client: Client, options?: { name?: unknown; bounds?: unknown }): void {
    const id = entityId(this.nextPlayerId++)
    const name = typeof options?.name === 'string' && options.name.trim() !== '' ? options.name : `Player ${id}`
    this.bound ??= boundOf(typeof options?.bounds === 'number' ? options.bounds : null)
    this.players.set(client, { client, id, name, latest: null, sentFull: false, baseline: new Map() })
    client.sendBytes(NET_CHANNEL, bytes(encodeWelcome({ playerId: id, bound: this.bound })))
    this.broadcastRoster()
  }

  override onLeave(client: Client): void {
    this.players.delete(client)
    this.broadcastRoster()
  }

  // Peer id -> name, on every join/leave. Names are static per session, so this only
  // fires on membership change — not per tick.
  private broadcastRoster(): void {
    const roster: RosterEntry[] = [...this.players.values()].map((p) => ({ id: p.id, name: p.name }))
    this.broadcastBytes(NET_CHANNEL, bytes(encodeRoster(roster)), {})
  }

  private onNet(client: Client, data: Uint8Array): void {
    const player = this.players.get(client)
    if (player === undefined) return
    // Every message self-describes its version; decoders reject a mismatch. Guard so
    // a malformed/wrong-version frame can't crash the room.
    try {
      const buf = toArrayBuffer(data)
      switch (readMessageType(buf)) {
        case MSG_STATE:
          player.latest = decodeState(buf)
          break
        case MSG_PING:
          client.sendBytes(
            NET_CHANNEL,
            bytes(encodePong({ clientTimeMs: decodePing(buf).clientTimeMs, serverTimeMs: this.serverTimeMs >>> 0 })),
          )
          break
      }
    } catch {
      // ignore (schema-version mismatch or corrupt frame)
    }
  }

  private tick(dtMs: number): void {
    const t0 = performance.now()
    this.serverTimeMs += dtMs
    const time = this.serverTimeMs >>> 0
    const all = [...this.players.values()]
    for (const player of all) {
      // Peers only: a client is authoritative for its own body, so never relay its
      // own position back to it.
      const peers: SnapshotEntity[] = []
      for (const other of all) {
        if (other === player || other.latest === null) continue
        peers.push({
          id: other.id,
          position: other.latest.position,
          flags: other.latest.flags,
          yaw: other.latest.yaw,
          speed: other.latest.speed,
          base: other.latest.base,
          teleports: other.latest.teleports,
        })
      }
      const bound = this.bound ?? QUANT_BOUND
      player.client.sendBytes(NET_CHANNEL, bytes(encodeSnapshot(deltaSnapshot(player, peers, time, bound), bound)))
    }
    const dur = performance.now() - t0
    statTicks += 1
    statSumMs += dur
    if (dur > statMaxMs) statMaxMs = dur
  }
}

/** Per-client delta baseline: whether a full has been sent, and the last states sent. */
export interface DeltaBaseline {
  sentFull: boolean
  baseline: Map<EntityId, PlayerState>
}

const asState = (e: SnapshotEntity): PlayerState => ({
  position: e.position,
  flags: e.flags,
  yaw: e.yaw,
  speed: e.speed,
  base: e.base,
  teleports: e.teleports,
})

/** A full snapshot on first send, then per-client deltas vs the last states sent.
 * Pure (mutates only the passed baseline) so it's unit-testable without Colyseus. */
export const deltaSnapshot = (s: DeltaBaseline, peers: SnapshotEntity[], time: number, bound: number = QUANT_BOUND): SnapshotMessage => {
  if (!s.sentFull) {
    s.sentFull = true
    s.baseline = new Map(peers.map((e) => [e.id, asState(e)]))
    return { isFull: true, serverTimeMs: time, changed: peers, removed: [] }
  }
  const changed: SnapshotEntity[] = []
  const present = new Set<EntityId>()
  for (const e of peers) {
    present.add(e.id)
    const base = s.baseline.get(e.id)
    if (base === undefined || relayDiffers(base, asState(e), bound)) changed.push(e)
  }
  const removed: EntityId[] = []
  for (const id of s.baseline.keys()) if (!present.has(id)) removed.push(id)
  s.baseline = new Map(peers.map((e) => [e.id, asState(e)]))
  return { isFull: false, serverTimeMs: time, changed, removed }
}
