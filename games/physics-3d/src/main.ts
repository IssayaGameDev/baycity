import { createSnapshotClient, createWebSocketClientTransport } from '@mp/client'
import type { EntityId } from '@mp/core'
import { decodeSnapshot } from '@mp/net'
import { THREE, createThreeStage } from '@mp/render-three'

const SERVER_URL = `ws://${location.hostname}:9200`

// PLACEHOLDER — interpolation buffer duration is a DESIGN decision (game feel);
// this value is only for the localhost demo. See docs/netcode.md.
const INTERPOLATION_DELAY_MS = 100

const canvas = document.querySelector<HTMLCanvasElement>('#view')!
const statusEl = document.querySelector<HTMLDivElement>('#status')!

const stage = createThreeStage({ canvas, cameraPosition: [0, 10, 20], lookAt: [0, 2, 0] })

// Scene content (lights, ground, meshes) is the game's concern, not the renderer's.
stage.scene.add(new THREE.AmbientLight(0xffffff, 0.6))
const sun = new THREE.DirectionalLight(0xffffff, 1.2)
sun.position.set(10, 20, 10)
stage.scene.add(sun)

const ground = new THREE.Mesh(
  new THREE.BoxGeometry(40, 0.2, 40),
  new THREE.MeshStandardMaterial({ color: 0x1e293b }),
)
stage.scene.add(ground)

const sphereGeo = new THREE.SphereGeometry(0.5, 24, 16)
const sphereMat = new THREE.MeshStandardMaterial({ color: 0x4fd1c5 })
const meshes = new Map<EntityId, THREE.Mesh>()

const client = createSnapshotClient({ interpolationDelayMs: INTERPOLATION_DELAY_MS })
const transport = createWebSocketClientTransport(SERVER_URL)

transport.onOpen(() => {
  statusEl.textContent = `connected: ${SERVER_URL}`
})
transport.onClose(() => {
  statusEl.textContent = `disconnected — run 'pnpm dev:server' (${SERVER_URL})`
})
transport.onMessage((data) => {
  client.ingest(decodeSnapshot(data))
})

stage.start(() => {
  for (const e of client.sample()) {
    let mesh = meshes.get(e.id)
    if (mesh === undefined) {
      mesh = new THREE.Mesh(sphereGeo, sphereMat)
      stage.scene.add(mesh)
      meshes.set(e.id, mesh)
    }
    mesh.position.set(e.position.x, e.position.y, e.position.z)
  }
})
