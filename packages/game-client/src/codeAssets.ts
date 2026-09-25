/**
 * Assets the game's own code loads by path, never through a level (ADR 0161). No level names them, so a build that
 * packs what its levels use packs these as well (`game-content.ts`). Paths from `content/`.
 */

/** The photo sky kept as the control backdrop (ADR 0046). */
export const SKY_TEXTURE = 'assets/textures/sky_110_2k.webp'

export const CODE_ASSETS: readonly string[] = [SKY_TEXTURE]
