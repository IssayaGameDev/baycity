import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

import { importAssets } from './src/assetImporter'

// Levels + prefabs live at repo-root content/ (shared, mode-agnostic) — the same files the game loads.
const DIRS: Record<string, string> = {
  levels: fileURLToPath(new URL('../../content/levels', import.meta.url)),
  prefabs: fileURLToPath(new URL('../../content/prefabs', import.meta.url)),
}
const ASSETS_DIR = fileURLToPath(new URL('../../content/assets', import.meta.url))
const ROUTE_RE = /^\/api\/(levels|prefabs)(?:\/([\w-]+))?$/

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  ktx2: 'image/ktx2',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  json: 'application/json',
}

const contentTypeFor = (path: string): string => {
  const dot = path.lastIndexOf('.')
  return (dot >= 0 ? CONTENT_TYPES[path.slice(dot + 1).toLowerCase()] : undefined) ?? 'application/octet-stream'
}

/**
 * Resolve a request path inside `root`, or `null` if it escapes it. `..` in a URL would otherwise read any
 * file on the machine, and this server has write routes too.
 */
const safeJoin = (root: string, rel: string): string | null => {
  const full = normalize(join(root, rel))
  return full === root || full.startsWith(root + sep) ? full : null
}

const sendJson = (res: ServerResponse, code: number, body: unknown): void => {
  res.statusCode = code
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

const readBody = async (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString()))
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })

/**
 * Dev-server file API for editing content on disk:
 *   GET  /api/{levels|prefabs}        → string[] of names (filenames without .json)
 *   GET  /api/{levels|prefabs}/:name  → the JSON
 *   PUT  /api/{levels|prefabs}/:name  → write the JSON (pretty-printed)
 *
 * And the asset tree at content/assets/:
 *   GET  /api/assets            → the database (runs the importer, so sidecars exist before anyone looks)
 *   GET  /assets/<path>         → the bytes, for a texture, model, sound or font
 *   PUT  /assets/<path>         → write a JSON asset (a material the editor authored)
 */
const filesApi = (): Plugin => ({
  name: 'files-api',
  configureServer(server) {
    for (const dir of [...Object.values(DIRS), ASSETS_DIR]) if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    // --- assets ---
    server.middlewares.use((req, res, next) => {
      const url = decodeURIComponent((req.url ?? '').split('?')[0] ?? '')

      if (url === '/api/assets' && req.method === 'GET') {
        const { entries, created } = importAssets(ASSETS_DIR)
        if (created.length > 0) console.log(`assets: wrote ${created.length} sidecar(s)`)
        sendJson(res, 200, { entries })
        return
      }

      if (!url.startsWith('/assets/')) {
        next()
        return
      }
      const file = safeJoin(ASSETS_DIR, url.slice('/assets/'.length))
      if (file === null) {
        sendJson(res, 400, { error: 'path escapes the assets root' })
        return
      }

      if (req.method === 'GET') {
        if (!existsSync(file) || statSync(file).isDirectory()) {
          sendJson(res, 404, { error: 'not found' })
          return
        }
        res.statusCode = 200
        res.setHeader('content-type', contentTypeFor(file))
        res.end(readFileSync(file))
        return
      }

      if (req.method === 'PUT') {
        void readBody(req).then((body) => {
          try {
            // JSON only: the editor authors materials, it does not upload binaries.
            const parsed: unknown = JSON.parse(body)
            mkdirSync(join(file, '..'), { recursive: true })
            writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`)
            sendJson(res, 200, { ok: true })
          } catch (e) {
            sendJson(res, 400, { error: String(e) })
          }
        })
        return
      }
      next()
    })

    // --- levels + prefabs ---
    server.middlewares.use((req, res, next) => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      const m = ROUTE_RE.exec(url)
      if (m === null) {
        next()
        return
      }
      const dir = DIRS[m[1]!]!
      const name = m[2]
      if (req.method === 'GET' && name === undefined) {
        const names = readdirSync(dir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => f.slice(0, -'.json'.length))
        sendJson(res, 200, names)
        return
      }
      if (name === undefined) {
        next()
        return
      }
      const file = join(dir, `${name}.json`)
      if (req.method === 'GET') {
        if (!existsSync(file)) {
          sendJson(res, 404, { error: 'not found' })
          return
        }
        sendJson(res, 200, JSON.parse(readFileSync(file, 'utf8')))
        return
      }
      if (req.method === 'PUT') {
        void readBody(req).then((body) => {
          try {
            const parsed: unknown = JSON.parse(body)
            writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`)
            sendJson(res, 200, { ok: true })
          } catch (e) {
            sendJson(res, 400, { error: String(e) })
          }
        })
        return
      }
      next()
    })
  },
})

// Localhost level/prefab editor. Own port so it runs alongside the game/server/viewer.
export default defineConfig({
  plugins: [filesApi()],
  server: { port: 5176 },
  build: { target: 'es2022' },
})
