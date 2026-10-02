import type Anthropic from '@anthropic-ai/sdk'

import type { GitHub } from './github'
import { Refused, type RepoFiles } from './repoFiles'

/**
 * The assistant's tools (ADR 0192): reading the repository and the issues, and **drafting** an issue or a comment for
 * the person to file. Read and report only, Kodjo's call — there is no tool that writes a file, a level, the scene or
 * the game, so nothing the model is told can make it do one.
 */

/** Something the assistant proposes and the person files, or does not, with a click. */
export type Draft =
  | { readonly id: string; readonly kind: 'issue'; readonly title: string; readonly body: string; readonly labels: readonly string[] }
  | { readonly id: string; readonly kind: 'comment'; readonly number: number; readonly body: string }

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_repo',
    description:
      'Search the files in the repository (code, docs, levels, prefabs, materials) for text. Returns matching lines as path:line:text. Use a short distinctive string; set regex for a regular expression; narrow with path (a file or folder).',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' }, path: { type: 'string' }, regex: { type: 'boolean' } },
      required: ['query'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file in the repository, with line numbers, up to 400 lines at a time: from_line and to_line choose which.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, from_line: { type: 'integer' }, to_line: { type: 'integer' } },
      required: ['path'],
    },
  },
  {
    name: 'list_files',
    description: 'List the files in a folder of the repository (and its subfolders). An empty dir lists from the top.',
    input_schema: { type: 'object', properties: { dir: { type: 'string' } }, required: ['dir'] },
  },
  {
    name: 'search_issues',
    description: "Search this repository's GitHub issues (open and closed). Always do this before drafting a new issue, so a bug is not filed twice.",
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'read_issue',
    description: 'Read one GitHub issue with its comments.',
    input_schema: { type: 'object', properties: { number: { type: 'integer' } }, required: ['number'] },
  },
  {
    name: 'draft_issue',
    description:
      'Propose a new GitHub issue. It is NOT filed: the person sees the draft and files it with a click, or not. Draft one only for a real problem the person agrees is one, after search_issues found nothing the same.',
    input_schema: {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } },
      required: ['title', 'body'],
    },
  },
  {
    name: 'draft_comment',
    description: 'Propose a comment on an existing GitHub issue — new information about a known bug. NOT posted: the person posts it with a click, or not.',
    input_schema: { type: 'object', properties: { number: { type: 'integer' }, body: { type: 'string' } }, required: ['number', 'body'] },
  },
]

/** What a tool did, in the words a person sees beside the chat while it works. */
export const activityOf = (name: string, input: Record<string, unknown>): string => {
  const s = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string) : '')
  switch (name) {
    case 'search_repo':
      return `Searching for “${s('query')}”${s('path') === '' ? '' : ` in ${s('path')}`}`
    case 'read_file':
      return `Reading ${s('path')}`
    case 'list_files':
      return `Looking in ${s('dir') === '' ? 'the repository' : s('dir')}`
    case 'search_issues':
      return `Searching issues for “${s('query')}”`
    case 'read_issue':
      return `Reading issue #${String(input.number ?? '')}`
    case 'draft_issue':
      return 'Drafting an issue'
    case 'draft_comment':
      return `Drafting a comment on #${String(input.number ?? '')}`
    default:
      // An editor action (ADR 0195): its name, as words.
      return name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
  }
}

export interface ToolRun {
  /** What goes back to the model: text, or blocks — a picture of the viewport and its words (ADR 0195). */
  readonly result: string | Exclude<Anthropic.ToolResultBlockParam['content'], string | undefined>
  readonly isError?: boolean
  /** A draft for the person, when the tool made one. */
  readonly draft?: Draft
  /** The turn ends after this: the person said no to the change, or stop (ADR 0195). */
  readonly ends?: boolean
}

export const createToolRunner = (deps: { readonly files: RepoFiles; readonly github: GitHub | null; readonly nextDraftId: () => string }) => {
  const text = (input: Record<string, unknown>, key: string): string => {
    const v = input[key]
    if (typeof v !== 'string' || v.trim() === '') throw new Refused(`${key} is required`)
    return v
  }
  const int = (input: Record<string, unknown>, key: string): number | undefined => (typeof input[key] === 'number' && Number.isFinite(input[key]) ? Math.floor(input[key] as number) : undefined)
  const needGitHub = (): GitHub => {
    if (deps.github === null) throw new Refused('GitHub is not set up on this server')
    return deps.github
  }

  return async (name: string, input: Record<string, unknown>): Promise<ToolRun> => {
    try {
      switch (name) {
        case 'search_repo':
          return { result: await deps.files.search(text(input, 'query'), { ...(typeof input.path === 'string' ? { path: input.path } : {}), regex: input.regex === true }) }
        case 'read_file':
          return { result: await deps.files.read(text(input, 'path'), int(input, 'from_line'), int(input, 'to_line')) }
        case 'list_files': {
          const files = await deps.files.list(typeof input.dir === 'string' ? input.dir : '')
          return { result: files.length === 0 ? 'no files there' : files.join('\n') }
        }
        case 'search_issues': {
          const found = await needGitHub().searchIssues(text(input, 'query'))
          return { result: found.length === 0 ? 'no issues match' : found.map((i) => `#${i.number} [${i.state}] ${i.title} — ${i.url}`).join('\n') }
        }
        case 'read_issue': {
          const n = int(input, 'number')
          if (n === undefined) throw new Refused('number is required')
          const i = await needGitHub().issue(n)
          const comments = i.comments.map((c) => `— ${c.author}: ${c.body}`).join('\n\n')
          return { result: `#${i.number} [${i.state}] ${i.title}\n${i.url}\n\n${i.body}${comments === '' ? '' : `\n\nComments:\n${comments}`}`.slice(0, 20_000) }
        }
        case 'draft_issue': {
          needGitHub()
          const labels = Array.isArray(input.labels) ? input.labels.filter((l): l is string => typeof l === 'string') : []
          const draft: Draft = { id: deps.nextDraftId(), kind: 'issue', title: text(input, 'title'), body: text(input, 'body'), labels }
          return { result: `Draft ${draft.id} is shown to the person. It is not filed unless they file it.`, draft }
        }
        case 'draft_comment': {
          needGitHub()
          const n = int(input, 'number')
          if (n === undefined) throw new Refused('number is required')
          const draft: Draft = { id: deps.nextDraftId(), kind: 'comment', number: n, body: text(input, 'body') }
          return { result: `Draft ${draft.id} is shown to the person. It is not posted unless they post it.`, draft }
        }
        default:
          return { result: `no tool called ${name}`, isError: true }
      }
    } catch (e) {
      return { result: e instanceof Refused ? `refused: ${e.message}` : `failed: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  }
}
