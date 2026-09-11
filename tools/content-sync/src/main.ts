import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isRepoContent, planSync, readEnv, type LocalFile, type RemoteFile } from './index'

/**
 * `pnpm sync:content` — a live, one-way mirror of the hosted editor's `content/` onto this PC (ADR 0084).
 *
 * The game dev server bundles content from disk, so a save on editor.playgorbo.com has to land on this disk to
 * be seen. This does that within a second: a full sync against `/api/tree`, then `/api/changes` long-polled,
 * each changed file fetched and written (or deleted). One way — anything written into the mirror by hand is
 * overwritten by the next change. It logs into Access with a **service token** (`.env`), never an email code.
 *
 * `.content-live/.sync.json` records the last sync time; the game's dev server reads it to say how fresh the
 * mirror is. Refuses to mirror into the repo's own `content/`: that folder is master's.
 */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const envFile = resolve(ROOT, '.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)
const env = readEnv(process.env)
const MIRROR = resolve(ROOT, env.root)
if (isRepoContent(MIRROR, ROOT)) {
  console.error(`refusing to mirror into ${MIRROR}: that is the repo's own content/, which is master's. Use another MP_CONTENT_ROOT.`)
  process.exit(2)
}
const POLL_TIMEOUT_MS = 25_000

const headers = { 'CF-Access-Client-Id': env.clientId, 'CF-Access-Client-Secret': env.clientSecret }
const stamp = (): string => new Date().toTimeString().slice(0, 8)
const log = (msg: string): void => console.log(`${stamp()} ${msg}`)

const api = async (path: string): Promise<Response> => {
  const r = await fetch(`${env.url}${path}`, { headers })
  if (r.status === 401 || r.status === 403) {
    throw new Error(`Access refused the service token (${r.status}). Expired or not in the Editor app's Service Auth policy.`)
  }
  return r
}

/** `content/...` → absolute path in the mirror (the mirror root *is* `content/`). */
const localPath = (p: string): string => join(MIRROR, p.slice('content/'.length))

const localFiles = (): LocalFile[] => {
  if (!existsSync(MIRROR)) return []
  const out: LocalFile[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name !== '.sync.json') {
        out.push({ path: `content/${relative(MIRROR, full).split('\\').join('/')}`, sha1: createHash('sha1').update(readFileSync(full)).digest('hex') })
      }
    }
  }
  walk(MIRROR)
  return out
}

const download = async (path: string): Promise<'written' | 'deleted'> => {
  const r = await api(`/api/file?path=${encodeURIComponent(path)}`)
  const file = localPath(path)
  if (r.status === 404) {
    rmSync(file, { force: true })
    return 'deleted'
  }
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, Buffer.from(await r.arrayBuffer()))
  return 'written'
}

const markSynced = (seq: number): void => {
  mkdirSync(MIRROR, { recursive: true })
  writeFileSync(join(MIRROR, '.sync.json'), `${JSON.stringify({ at: new Date().toISOString(), seq, url: env.url })}\n`)
}

const fullSync = async (): Promise<number> => {
  const r = await api('/api/tree')
  if (!r.ok) throw new Error(`GET /api/tree → ${r.status}`)
  const tree = (await r.json()) as { seq: number; files: RemoteFile[] }
  const plan = planSync(tree.files, localFiles())
  for (const p of plan.delete) {
    rmSync(localPath(p), { force: true })
    log(`✕ ${p}`)
  }
  for (const p of plan.download) {
    await download(p)
    log(`↓ ${p}`)
  }
  markSynced(tree.seq)
  log(`in sync: ${tree.files.length} files, ${plan.download.length} fetched, ${plan.delete.length} removed → ${MIRROR}`)
  return tree.seq
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const run = async (): Promise<void> => {
  let seq = await fullSync()
  let failures = 0
  for (;;) {
    try {
      const r = await api(`/api/changes?since=${seq}&timeout=${POLL_TIMEOUT_MS}`)
      if (r.status === 410) {
        log('fell behind the feed; full sync')
        seq = await fullSync()
        continue
      }
      if (!r.ok) throw new Error(`GET /api/changes → ${r.status}`)
      const batch = (await r.json()) as { seq: number; paths: string[] }
      for (const p of batch.paths) log(`${(await download(p)) === 'written' ? '↓' : '✕'} ${p}`)
      seq = batch.seq
      markSynced(seq)
      failures = 0
    } catch (e) {
      failures++
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5))
      console.error(`${stamp()} !! ${e instanceof Error ? e.message : String(e)} — retrying in ${wait / 1000}s (the game is showing a stale mirror meanwhile)`)
      await sleep(wait)
      if (failures % 5 === 0) {
        try {
          seq = await fullSync()
        } catch {
          // reported on the next loop
        }
      }
    }
  }
}

log(`mirroring ${env.url} → ${MIRROR}`)
void run()
