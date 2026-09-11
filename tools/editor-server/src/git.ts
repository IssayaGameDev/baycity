import { execFile } from 'node:child_process'

import type { User } from './config'

/**
 * The little git the server needs: commit a set of paths as someone, push a branch.
 *
 * The server is the **only writer** to its branch (ADR 0083). It never pulls, rebases or merges — the working
 * tree holds other people's uncommitted work at any moment, and any of those would be where files get eaten.
 * Deploy merges master in, after committing every session first. A refused push is reported, not retried
 * with force.
 */
export const git = (repoRoot: string, args: readonly string[], env: Record<string, string> = {}): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd: repoRoot, env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err !== null) reject(new Error(`git ${args[0] ?? ''}: ${stderr.trim() || err.message}`))
      else resolve(stdout)
    })
  })

/** Paths under `paths` that differ from HEAD (modified, added, deleted, untracked), from `git status`. */
export const changedUnder = async (repoRoot: string, paths: readonly string[]): Promise<string[]> => {
  if (paths.length === 0) return []
  const out = await git(repoRoot, ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...paths])
  const changed: string[] = []
  const entries = out.split('\0')
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    if (e.length < 4) continue
    changed.push(e.slice(3))
    // A rename entry carries the source in the next NUL-separated field.
    if (e[0] === 'R' || e[1] === 'R') i++
  }
  return changed
}

export interface CommitRequest {
  paths: readonly string[]
  author: User
  committer: User
  message: string
}

export type CommitResult = { committed: true; sha: string; paths: string[] } | { committed: false }

/**
 * Commit exactly what changed under `paths`, as `author`. Nothing else in the tree is touched — other people's
 * dirty files stay dirty. Returns `committed: false` when the paths turned out unchanged (saved without a diff).
 */
export const commitPaths = async (repoRoot: string, req: CommitRequest): Promise<CommitResult> => {
  const changed = await changedUnder(repoRoot, req.paths)
  if (changed.length === 0) return { committed: false }
  await git(repoRoot, ['add', '-A', '--', ...changed])
  const env = {
    GIT_AUTHOR_NAME: req.author.name,
    GIT_AUTHOR_EMAIL: req.author.email,
    GIT_COMMITTER_NAME: req.committer.name,
    GIT_COMMITTER_EMAIL: req.committer.email,
  }
  await git(repoRoot, ['commit', '--quiet', '--no-verify', '--only', '-m', req.message, '--', ...changed], env)
  const sha = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim()
  return { committed: true, sha, paths: changed }
}

export const push = (repoRoot: string, branch: string): Promise<string> => git(repoRoot, ['push', '--quiet', 'origin', branch])

export const currentBranch = async (repoRoot: string): Promise<string> => (await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
