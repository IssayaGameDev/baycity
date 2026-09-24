import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The editor's `vite.config.ts` bundles the content API by relative path, and Vite loads the bundle through
 * plain Node — which cannot load a workspace package whose entry is `.ts`. Type imports are erased, so only a
 * **value** import of `@mp/…` breaks it, and it breaks `pnpm --filter @mp/editor run build`, which is the
 * deploy (`deploy/editor/update.sh`). A sequence check once pulled `@mp/core` in that way (`eases.ts`).
 */

const CONFIG = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'vite.config.ts')
/** An import or re-export clause is names, braces, commas, `*` and `as` — never a `(` or `=` of code. */
const IMPORT = /^\s*(import|export)\s+(type\s+)?([\w\s{},*$]*?)\s*from\s+'([^']+)'/gm

/** A named list whose every name is `type X` is erased as surely as `import type`. */
const onlyTypes = (clause: string): boolean => {
  const named = /^\{([\s\S]*)\}$/.exec(clause.trim())
  if (named === null) return false
  const names = named[1]!.split(',').map((n) => n.trim()).filter((n) => n !== '')
  return names.length > 0 && names.every((n) => n.startsWith('type '))
}

const resolveTs = (from: string, spec: string): string | null => {
  const base = resolve(dirname(from), spec)
  for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) if (candidate.endsWith('.ts') && existsSync(candidate)) return candidate
  return null
}

/** Every value import of a workspace package reachable from the config by relative paths, as `file → spec`. */
const workspaceValueImports = (): string[] => {
  const found: string[] = []
  const seen = new Set<string>()
  const walk = (file: string): void => {
    if (seen.has(file)) return
    seen.add(file)
    for (const m of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const [, , typeOnly, clause, spec] = m
      if (typeOnly !== undefined || onlyTypes(clause!)) continue
      if (spec!.startsWith('.')) {
        const next = resolveTs(file, spec!)
        if (next !== null) walk(next)
      } else if (spec!.startsWith('@mp/') || spec!.startsWith('@mode/')) found.push(`${file} → ${spec}`)
    }
  }
  walk(CONFIG)
  return found
}

describe('the editor’s vite config', () => {
  it('reaches no workspace package at run time, so plain Node can load it', () => {
    expect(workspaceValueImports()).toEqual([])
  })
})
