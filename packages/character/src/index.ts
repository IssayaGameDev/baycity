/**
 * @mp/character — kinematic character-controller library (stack-level, mode-agnostic).
 * Roblox-like locomotion; feel is data. Run by each client for its own body and by
 * bots. See ADR 0012 (controller) and the content-pipeline ADR (layering).
 */
export const CHARACTER_VERSION = '0.0.0' as const

export type { CharacterTuning, CharacterState } from './character'
export {
  TICK_RATE_HZ,
  TICK_DT,
  CHAR_RADIUS,
  CHAR_HALF_HEIGHT,
  DEFAULT_TUNING,
  playerSpawn,
  addCharacter,
  stepCharacter,
} from './character'
