import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

// Levels + prefabs live at repo-root content/ (shared, mode-agnostic) — the same files the game loads.
const DIRS: Record<string, string> = {
  levels: fileURLToPath(new URL('../../content/levels', import.meta.url)),
  prefabs: fileURLToPath(new URL('../../content/prefabs', import.meta.url)),
}
const ROUTE_RE = /^\/api\/(levels|prefabs)(?:\/([\w-]+))?$/

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
 */
const filesApi = (): Plugin => ({
  name: 'files-api',
  configureServer(server) {
    for (const dir of Object.values(DIRS)) if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
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
