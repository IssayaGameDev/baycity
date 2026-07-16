import { createSnapshotClient, createWebSocketClientTransport } from '@mp/client'
import { decodeSnapshot } from '@mp/net'

const SERVER_PORT = 9200
const SERVER_URL = `ws://${location.hostname}:${SERVER_PORT}`

// PLACEHOLDER — interpolation buffer duration is a DESIGN decision (game feel);
// this value is only for the localhost demo. See docs/netcode.md.
const INTERPOLATION_DELAY_MS = 100

// World units shown across the canvas (sphere orbits radius 5 in XZ).
const WORLD_VIEW = 14

const canvas = document.querySelector<HTMLCanvasElement>('#view')!
const ctx = canvas.getContext('2d')!
const statusEl = document.querySelector<HTMLDivElement>('#status')!

const client = createSnapshotClient({ interpolationDelayMs: INTERPOLATION_DELAY_MS })
const transport = createWebSocketClientTransport(SERVER_URL)

transport.onOpen(() => {
  statusEl.textContent = `connected: ${SERVER_URL}`
})
transport.onClose(() => {
  statusEl.textContent = `disconnected — is the server running? (${SERVER_URL})`
})
transport.onMessage((data) => {
  client.ingest(decodeSnapshot(data))
})

const draw = (): void => {
  const { width, height } = canvas
  ctx.clearRect(0, 0, width, height)

  // origin cross
  ctx.strokeStyle = '#1e293b'
  ctx.beginPath()
  ctx.moveTo(width / 2, 0)
  ctx.lineTo(width / 2, height)
  ctx.moveTo(0, height / 2)
  ctx.lineTo(width, height / 2)
  ctx.stroke()

  const scale = width / WORLD_VIEW
  ctx.fillStyle = '#4fd1c5'
  for (const e of client.sample()) {
    const px = width / 2 + e.position.x * scale
    const py = height / 2 + e.position.z * scale // top-down: world z -> screen y
    ctx.beginPath()
    ctx.arc(px, py, 10, 0, Math.PI * 2)
    ctx.fill()
  }

  requestAnimationFrame(draw)
}

requestAnimationFrame(draw)
