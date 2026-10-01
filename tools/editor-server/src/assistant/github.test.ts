import { describe, expect, it } from 'vitest'

import { createGitHub, repoOfRemote } from './github'

/** The issues, for the assistant (ADR 0192): the repository from the checkout's remote, and plain REST calls. */
describe('GitHub for the assistant', () => {
  it('reads owner/name from a remote, either form', () => {
    expect(repoOfRemote('git@github.com:kodjo/multiplayer-web.git')).toBe('kodjo/multiplayer-web')
    expect(repoOfRemote('https://github.com/kodjo/multiplayer-web.git\n')).toBe('kodjo/multiplayer-web')
    expect(repoOfRemote('https://github.com/kodjo/multiplayer-web')).toBe('kodjo/multiplayer-web')
    expect(repoOfRemote('https://gitlab.com/a/b.git')).toBeNull()
  })

  it('searches this repository’s issues and files one with its token', async () => {
    const calls: { url: string; method: string; auth: string; body?: string }[] = []
    const fetch = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      calls.push({ url, method: init?.method ?? 'GET', auth: init?.headers?.authorization ?? '', ...(init?.body === undefined ? {} : { body: init.body }) })
      const json = url.includes('/search/issues')
        ? { items: [{ number: 7, title: 'Hazard does not kill', state: 'open', html_url: 'https://github.com/o/r/issues/7' }] }
        : { number: 8, html_url: 'https://github.com/o/r/issues/8' }
      return { ok: true, status: 200, json: async () => json }
    }
    const gh = createGitHub({ token: 't0k', repo: 'o/r', fetch })
    expect(await gh.searchIssues('hazard')).toEqual([{ number: 7, title: 'Hazard does not kill', state: 'open', url: 'https://github.com/o/r/issues/7' }])
    expect(decodeURIComponent(calls[0]!.url)).toContain('q=repo:o/r is:issue hazard')
    expect(await gh.createIssue('T', 'B', ['bug'])).toEqual({ number: 8, url: 'https://github.com/o/r/issues/8' })
    expect(calls[1]).toMatchObject({ url: 'https://api.github.com/repos/o/r/issues', method: 'POST', auth: 'Bearer t0k' })
    expect(JSON.parse(calls[1]!.body!)).toEqual({ title: 'T', body: 'B', labels: ['bug'] })
  })
})
