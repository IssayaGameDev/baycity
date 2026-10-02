import type Anthropic from '@anthropic-ai/sdk'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ASSISTANT_MODES, type AssistantMode, type Conversation, type Shown } from './agent'
import { DEFAULT_MODEL, modelOf } from './models'
import type { Draft } from './tools'

/**
 * The assistant's sessions on disk (ADR 0197, Kodjo's calls): every person's conversations kept in the state directory
 * — across tabs, browsers and deploys — until thirty days unused, and a warning once they all take more than a size.
 *
 * One folder a person, named by a hash of their email so no address is a path; one file a conversation, written
 * whole after each change, through a temporary file so a crash leaves the last good one. Pictures of the viewport are
 * not kept: they matter to the turn that took them, and they are most of a conversation's bytes.
 */

/** Days a session is kept without being used. */
export const SESSION_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

/** A session as the list shows it. */
export interface SessionSummary {
  readonly id: string
  readonly title: string
  readonly mode: AssistantMode
  readonly lastUsed: number
}

/** What a file holds: the conversation, its maps as entries. */
interface Saved {
  readonly v: 1
  readonly id: string
  readonly email: string
  readonly name: string
  readonly title: string
  readonly mode: AssistantMode
  /** Absent from a file saved before ADR 0199: the default. */
  readonly model?: string
  readonly createdAt: number
  readonly lastUsed: number
  readonly messages: Anthropic.MessageParam[]
  readonly shown: Shown[]
  readonly drafts: [string, Draft][]
  readonly filed: [string, string][]
}

export interface SessionStore {
  /** A person's sessions, the latest used first. */
  readonly list: (email: string) => SessionSummary[]
  /** One of a person's sessions, or `null` — never another person's. */
  readonly load: (email: string, id: string) => Conversation | null
  readonly save: (conv: Conversation) => void
  /** `true` when there was one to delete. */
  readonly remove: (email: string, id: string) => boolean
  /** Delete what has gone unused for `SESSION_DAYS`; what is left, in bytes. */
  readonly sweep: (now: number) => { readonly removed: number; readonly bytes: number }
}

/** What a session is called: the first words of its first message. */
export const titleOf = (text: string): string => {
  const words = text.replace(/\s+/g, ' ').trim()
  return words.length <= 48 ? words : `${words.slice(0, 47).trimEnd()}…`
}

/** A message as it is kept: a picture's block put down to words. */
const withoutPictures = (m: Anthropic.MessageParam): Anthropic.MessageParam => {
  if (typeof m.content === 'string') return m
  return {
    role: m.role,
    content: m.content.map((b): Anthropic.ContentBlockParam => {
      if (b.type !== 'tool_result' || typeof b.content === 'string' || b.content === undefined) return b
      return { ...b, content: b.content.map((x) => (x.type === 'image' ? { type: 'text', text: '[a picture of the viewport, not kept]' } : x)) }
    }),
  }
}

const isSaved = (v: unknown): v is Saved => {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Partial<Saved>
  return s.v === 1 && typeof s.id === 'string' && typeof s.email === 'string' && Array.isArray(s.messages) && Array.isArray(s.shown) && typeof s.lastUsed === 'number'
}

export const createSessionStore = (dir: string): SessionStore => {
  const personDir = (email: string): string => join(dir, createHash('sha256').update(email).digest('hex').slice(0, 16))
  const fileOf = (email: string, id: string): string => join(personDir(email), `${id}.json`)
  const ID = /^[0-9a-f]{32}$/

  const read = (file: string): Saved | null => {
    try {
      const v: unknown = JSON.parse(readFileSync(file, 'utf8'))
      return isSaved(v) ? v : null
    } catch {
      return null
    }
  }

  return {
    list: (email) => {
      const at = personDir(email)
      if (!existsSync(at)) return []
      return readdirSync(at)
        .filter((f) => f.endsWith('.json'))
        .map((f) => read(join(at, f)))
        .filter((s): s is Saved => s !== null && s.email === email)
        .map((s) => ({ id: s.id, title: s.title, mode: ASSISTANT_MODES.includes(s.mode) ? s.mode : 'assistant', lastUsed: s.lastUsed }))
        .sort((a, b) => b.lastUsed - a.lastUsed)
    },
    load: (email, id) => {
      if (!ID.test(id)) return null
      const s = read(fileOf(email, id))
      if (s === null || s.email !== email) return null
      return {
        id: s.id,
        email: s.email,
        name: s.name,
        title: s.title,
        mode: ASSISTANT_MODES.includes(s.mode) ? s.mode : 'assistant',
        // A model since taken off the list is the default's again.
        model: (modelOf(s.model) ?? DEFAULT_MODEL).id,
        createdAt: s.createdAt,
        messages: s.messages,
        shown: s.shown,
        drafts: new Map(s.drafts),
        filed: new Map(s.filed),
        lastUsed: s.lastUsed,
        busy: false,
        stopping: false,
      }
    },
    save: (c) => {
      const saved: Saved = {
        v: 1,
        id: c.id,
        email: c.email,
        name: c.name,
        title: c.title,
        mode: c.mode,
        model: c.model,
        createdAt: c.createdAt,
        lastUsed: c.lastUsed,
        messages: c.messages.map(withoutPictures),
        shown: c.shown,
        drafts: [...c.drafts],
        filed: [...c.filed],
      }
      mkdirSync(personDir(c.email), { recursive: true })
      const file = fileOf(c.email, c.id)
      writeFileSync(`${file}.tmp`, JSON.stringify(saved))
      renameSync(`${file}.tmp`, file)
    },
    remove: (email, id) => {
      if (!ID.test(id)) return false
      const file = fileOf(email, id)
      if (!existsSync(file)) return false
      rmSync(file)
      return true
    },
    sweep: (now) => {
      let removed = 0
      let bytes = 0
      if (!existsSync(dir)) return { removed, bytes }
      for (const person of readdirSync(dir)) {
        const at = join(dir, person)
        if (!statSync(at).isDirectory()) continue
        for (const f of readdirSync(at)) {
          const file = join(at, f)
          // Saved whenever it is used, so the file's own time is when it last was.
          const st = statSync(file)
          if (now - st.mtimeMs > SESSION_DAYS * DAY_MS) {
            rmSync(file)
            removed++
          } else bytes += st.size
        }
      }
      return { removed, bytes }
    },
  }
}
