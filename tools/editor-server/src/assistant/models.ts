import type { Prices } from './budget'

/**
 * The models the assistant answers with (ADR 0199, Kodjo's calls): Haiku for everyone; the others for the people
 * `assistant-editors` names, picked beside Send and changeable at any message. Each carries its prices, so the day's
 * budget counts what its answers cost (Anthropic's list, October 2026).
 */
export interface AssistantModel {
  readonly id: string
  readonly label: string
  readonly prices: Prices
}

export const MODELS: readonly AssistantModel[] = [
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', prices: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 } },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', prices: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 } },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', prices: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 } },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', prices: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 } },
]

/** The cheaper, Kodjo's call: a new chat's, and the only one for anyone who may not pick. */
export const DEFAULT_MODEL: AssistantModel = MODELS[0]!

/** One of `MODELS` by its id, or `undefined`. */
export const modelOf = (id: unknown): AssistantModel | undefined => MODELS.find((m) => m.id === id)
