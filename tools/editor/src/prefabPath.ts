/**
 * Where `Save as prefab…` writes, and whether it may (ADR 0091).
 *
 * Pure, and separate from `main.ts`, so the two rules that matter are testable: a name that is safe as a file
 * name, and a refusal when something is already there. That second one is not fussiness — creating a prefab
 * file over an existing one would keep the old `.meta` sidecar, so the asset **id** would survive while its
 * contents changed, and every level referencing that id would silently become something else. Refusing is the
 * only safe answer, and it matches how a new level is refused rather than auto-numbered.
 */

/** The folder the save goes to: the one open in the Project panel, or `prefabs/` at the root or across folders. */
export const prefabFolder = (open: string | null): string => (open === null || open === '' ? 'prefabs' : open)

/** A name offered to the dialog: the object's, with everything a file name cannot carry turned into `-`. */
export const sanitisePrefabName = (raw: string): string => {
  const cleaned = raw
    .trim()
    .replace(/[^\w-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
  return cleaned === '' ? 'prefab' : cleaned
}

export type PrefabTarget = { path: string; name: string } | { error: string }

/**
 * The path a save would write, or why it cannot. `taken` is every asset path the database knows, so a name
 * already used in the destination folder is a refusal rather than an overwrite.
 */
export const prefabTarget = (folder: string | null, name: string, taken: readonly string[]): PrefabTarget => {
  const trimmed = name.trim()
  if (trimmed === '') return { error: 'a prefab needs a name' }
  if (!/^[\w-]+$/.test(trimmed)) return { error: `"${trimmed}" is not a file name: letters, digits, - and _ only` }
  const dir = prefabFolder(folder)
  const path = `${dir}/${trimmed}.prefab.json`
  if (taken.includes(path)) return { error: `a prefab called ${trimmed} is already in ${dir}/` }
  return { path, name: trimmed }
}
