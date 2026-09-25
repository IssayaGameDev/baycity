/**
 * What a game carries of `content/` (ADR 0161), made by the `gameContent` plugin in the repo's `game-content.ts`:
 * each table keyed by the file's path from `content/`.
 */
declare module 'virtual:game-content' {
  /** The game's level files, parsed. */
  export const LEVELS: Record<string, unknown>
  /** Each asset's `.meta` sidecar, as text, keyed by the asset's own path. */
  export const METAS: Record<string, string>
  /** Materials, parsed. */
  export const MATERIALS: Record<string, unknown>
  /** Prefab files, parsed. */
  export const PREFABS: Record<string, unknown>
  /** Every other asset: the URL its bytes are served at. */
  export const URLS: Record<string, string>
}
