/**
 * The live mirror's pure parts (ADR 0084): what a full sync must download and delete, and how the env is read.
 * `main.ts` does the network and the disk.
 */
export interface RemoteFile {
  /** `content/...`, forward slashes. */
  path: string
  size: number
  sha1: string
}

export interface LocalFile {
  path: string
  sha1: string
}

export interface SyncPlan {
  download: string[]
  delete: string[]
}

/** Download what differs or is missing; delete what the server no longer has. Paths sorted, so logs read well. */
export const planSync = (remote: readonly RemoteFile[], local: readonly LocalFile[]): SyncPlan => {
  const have = new Map(local.map((f) => [f.path, f.sha1]))
  const want = new Map(remote.map((f) => [f.path, f.sha1]))
  return {
    download: remote.filter((f) => have.get(f.path) !== f.sha1).map((f) => f.path).sort(),
    delete: local.filter((f) => !want.has(f.path)).map((f) => f.path).sort(),
  }
}

export interface SyncEnv {
  /** `https://editor.playgorbo.com` */
  url: string
  clientId: string
  clientSecret: string
  /** Where the mirror is written; relative to the repo root. */
  root: string
}

/** Read the four variables; a missing one is a clear error naming it, not a confusing 401 later. */
export const readEnv = (env: Record<string, string | undefined>): SyncEnv => {
  const need = (name: string): string => {
    const v = env[name]
    if (v === undefined || v === '') throw new Error(`${name} is not set — copy .env.example to .env and fill it in`)
    return v
  }
  const clientId = need('MP_ACCESS_CLIENT_ID')
  const clientSecret = need('MP_ACCESS_CLIENT_SECRET')
  // Shape only, never the values: a pasted header name or a stray space is the usual mistake. Lengths are not
  // checked — Cloudflare's are its own business — only what can never be part of a value.
  for (const [name, v] of [['MP_ACCESS_CLIENT_ID', clientId], ['MP_ACCESS_CLIENT_SECRET', clientSecret]] as const) {
    if (/[\s:]/.test(v)) throw new Error(`${name} contains a space or a colon — paste only the value, not the header name`)
  }
  if (!clientId.endsWith('.access')) throw new Error(`MP_ACCESS_CLIENT_ID does not end in .access — got ${clientId.length} characters`)
  return {
    url: need('MP_EDITOR_URL').replace(/\/+$/, ''),
    clientId,
    clientSecret,
    root: env.MP_CONTENT_ROOT === undefined || env.MP_CONTENT_ROOT === '' ? '.content-live' : env.MP_CONTENT_ROOT,
  }
}

/** The mirror must never be the repo's own `content/`: that is master's, merged in from the content branch. */
export const isRepoContent = (rootAbs: string, repoAbs: string): boolean => {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(rootAbs) === `${norm(repoAbs)}/content`
}
