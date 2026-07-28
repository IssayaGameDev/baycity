import { spawn, type ChildProcess } from 'node:child_process'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'

import { composeShareLink, findTunnelUrl } from './index'

/**
 * Share the local dev stack over two Cloudflare quick tunnels and print one link.
 *
 *   pnpm share
 *
 * Debug-only, opt-in: nothing in the normal `dev:server` + `dev:parkour` flow changes.
 * Quick tunnels are anonymous and get a fresh random hostname per run, so the link is
 * different every session and dies when this process does. Traffic is relayed through
 * Cloudflare's edge — latency is inflated, so don't read game-feel or clock-sync numbers
 * off it.
 *
 * Already-running dev servers are reused; only what's missing gets started.
 */
const RELAY_PORT = 9200
const PAGE_PORT = 5174
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const TUNNEL_TIMEOUT_MS = 30_000
const BOOT_TIMEOUT_MS = 60_000

const NO_CLOUDFLARED =
  'cloudflared not found on PATH. Install it (winget install Cloudflare.cloudflared) and retry.'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Vite binds ::1 only (no --host) while the relay binds ::, so probe both families. */
const probe = (host: string, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const sock = connect({ host, port })
    const settle = (up: boolean): void => {
      sock.destroy()
      resolve(up)
    }
    sock.once('connect', () => settle(true))
    sock.once('error', () => settle(false))
    sock.setTimeout(500, () => settle(false))
  })

const isUp = async (port: number): Promise<boolean> =>
  (await Promise.all([probe('127.0.0.1', port), probe('::1', port)])).some(Boolean)

const children: ChildProcess[] = []

const run = (label: string, command: string, args: string[], keep: (line: string) => boolean): ChildProcess => {
  const child = spawn(command, args, { cwd: ROOT, shell: true })
  children.push(child)
  const forward = (chunk: Buffer): void => {
    for (const line of chunk.toString().split('\n')) {
      const text = line.trimEnd()
      if (text.trim() !== '' && keep(text)) console.log(`[${label}] ${text}`)
    }
  }
  child.stdout?.on('data', forward)
  child.stderr?.on('data', forward)
  return child
}

/** `child.kill()` leaves grandchildren behind on Windows (pnpm → node), orphaning the
 * dev servers and holding the ports. taskkill /T walks the tree. */
const killTree = (child: ChildProcess): void => {
  if (child.pid === undefined || child.exitCode !== null) return
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill('SIGTERM')
}

const assertCloudflared = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const check = spawn('cloudflared', ['--version'], { shell: true, stdio: 'ignore' })
    check.once('error', () => reject(new Error(NO_CLOUDFLARED)))
    check.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(NO_CLOUDFLARED))))
  })

const waitForPort = async (port: number, label: string): Promise<void> => {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await isUp(port)) return
    await sleep(300)
  }
  throw new Error(`${label} never started listening on :${port}`)
}

const waitForTunnelUrl = (child: ChildProcess, label: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} never reported a hostname`)), TUNNEL_TIMEOUT_MS)
    const scan = (chunk: Buffer): void => {
      const url = findTunnelUrl(chunk.toString())
      if (url === null) return
      clearTimeout(timer)
      resolve(url)
    }
    child.stdout?.on('data', scan)
    child.stderr?.on('data', scan)
  })

const startTunnel = (label: string, port: number): ChildProcess =>
  run(label, 'cloudflared', ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], (line) =>
    line.includes('ERR'),
  )

const main = async (): Promise<void> => {
  await assertCloudflared()

  const [relayUp, pageUp] = await Promise.all([isUp(RELAY_PORT), isUp(PAGE_PORT)])

  if (relayUp) console.log(`[share] reusing the relay already on :${RELAY_PORT}`)
  else run('relay', 'pnpm', ['dev:server'], () => true)

  if (pageUp) console.log(`[share] reusing the page server already on :${PAGE_PORT}`)
  else run('page', 'pnpm', ['dev:parkour'], () => true)

  await Promise.all([waitForPort(RELAY_PORT, 'relay'), waitForPort(PAGE_PORT, 'page server')])

  console.log('[share] opening tunnels…')
  const relayTunnel = startTunnel('tunnel:relay', RELAY_PORT)
  const pageTunnel = startTunnel('tunnel:page', PAGE_PORT)
  const [relayUrl, pageUrl] = await Promise.all([
    waitForTunnelUrl(relayTunnel, 'relay tunnel'),
    waitForTunnelUrl(pageTunnel, 'page tunnel'),
  ])

  console.log(`\n  send this:\n\n  ${composeShareLink(pageUrl, relayUrl)}\n\n  Ctrl+C to tear it all down.\n`)
}

const shutdown = (): void => {
  for (const child of children) killTree(child)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log('\n[share] shutting down…')
    shutdown()
    process.exit(0)
  })
}

main().catch((err: unknown) => {
  console.error(`[share] ${err instanceof Error ? err.message : String(err)}`)
  shutdown()
  process.exit(1)
})
