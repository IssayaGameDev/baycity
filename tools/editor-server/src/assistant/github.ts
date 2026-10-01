/**
 * The repository's issues, for the assistant (ADR 0192): read them, and file what a person has confirmed. Plain
 * calls to GitHub's REST API with the server's own token — a fine-grained one, issues only, this repository only —
 * which never reaches the model or the browser.
 */

export interface IssueSummary {
  readonly number: number
  readonly title: string
  readonly state: string
  readonly url: string
}

export interface IssueDetail extends IssueSummary {
  readonly body: string
  readonly comments: readonly { readonly author: string; readonly body: string }[]
}

export interface GitHub {
  readonly repo: string
  searchIssues: (query: string) => Promise<readonly IssueSummary[]>
  issue: (number: number) => Promise<IssueDetail>
  createIssue: (title: string, body: string, labels: readonly string[]) => Promise<{ number: number; url: string }>
  comment: (number: number, body: string) => Promise<{ url: string }>
}

/** `owner/name` from a remote URL — `git@github.com:o/n.git` or `https://github.com/o/n(.git)` — or `null`. */
export const repoOfRemote = (url: string): string | null => {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m === null ? null : `${m[1]}/${m[2]}`
}

type Fetch = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {})

const summaryOf = (raw: unknown): IssueSummary => {
  const r = obj(raw)
  return { number: num(r.number), title: str(r.title), state: str(r.state), url: str(r.html_url) }
}

export const createGitHub = (opts: { readonly token: string; readonly repo: string; readonly fetch?: Fetch }): GitHub => {
  const doFetch: Fetch = opts.fetch ?? (globalThis.fetch as unknown as Fetch)
  const call = async (path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> => {
    const r = await doFetch(`https://api.github.com${path}`, {
      method: init.method ?? 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${opts.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'mp-editor-assistant',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`)
    return r.json()
  }
  const base = `/repos/${opts.repo}`
  return {
    repo: opts.repo,
    searchIssues: async (query) => {
      const q = encodeURIComponent(`repo:${opts.repo} is:issue ${query}`)
      const items = obj(await call(`/search/issues?q=${q}&per_page=10`)).items
      return Array.isArray(items) ? items.map(summaryOf) : []
    },
    issue: async (number) => {
      const raw = obj(await call(`${base}/issues/${number}`))
      const comments = await call(`${base}/issues/${number}/comments?per_page=30`)
      return {
        ...summaryOf(raw),
        body: str(raw.body),
        comments: Array.isArray(comments) ? comments.map((c) => ({ author: str(obj(obj(c).user).login), body: str(obj(c).body) })) : [],
      }
    },
    createIssue: async (title, body, labels) => {
      const raw = obj(await call(`${base}/issues`, { method: 'POST', body: { title, body, labels } }))
      return { number: num(raw.number), url: str(raw.html_url) }
    },
    comment: async (number, body) => {
      const raw = obj(await call(`${base}/issues/${number}/comments`, { method: 'POST', body: { body } }))
      return { url: str(raw.html_url) }
    },
  }
}
