/** Jira Cloud REST client. Credentials are read only from the host environment; errors exclude remote bodies. */
import { z } from 'zod'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { JiraCommentSchema, JiraIssueSchema, type JiraConfig, type JiraIssue } from './jira-trigger.ts'

/** A sanitized HTTP failure with the server's minimum retry delay. */
export class JiraError extends HarnessError {
  constructor(readonly status: number, readonly retryMs = 0) { super(`Jira HTTP ${status}${status === 401 || status === 403 ? ': check API token scopes and project permissions' : ''}`, 'JIRA_HTTP_ERROR') }
}
export const JiraCommentsPage = z.looseObject({ startAt: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
  comments: z.array(JiraCommentSchema) })
const SearchPage = z.looseObject({ issues: z.array(JiraIssueSchema), nextPageToken: z.string().optional(), isLast: z.boolean().optional() })
/** Bounded, abortable Jira Cloud REST access using an environment-held API token. */
export class JiraClient {
  constructor(readonly config: JiraConfig, private readonly signal?: AbortSignal) {}
  async request<T>(schema: z.ZodType<T>, path: string, body?: unknown): Promise<T> {
    const { site, cloudId, email, tokenEnv } = this.config
    const token = process.env[tokenEnv]
    if (!site || !email || !token) throw new Error(`Jira needs a site, account email and the ${tokenEnv} environment variable`)
    const base = cloudId ? `https://api.atlassian.com/ex/jira/${cloudId}` : site
    const response = await fetch(`${base}/rest/api/3/${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
        ...body === undefined ? {} : { 'Content-Type': 'application/json' } },
      ...body === undefined ? {} : { body: JSON.stringify(body) }, redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...this.signal ? [this.signal] : []]) })
    if (!response.ok) {
      const retry = response.headers.get('retry-after')
      const retryMs = retry ? /^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now()) : 0
      await response.body?.cancel()
      throw new JiraError(response.status, Number.isFinite(retryMs) ? retryMs : 0)
    }
    // Do not include Jira response values in validation diagnostics (they may contain restricted issue text).
    const json: unknown = await response.json().catch(() => { throw new Error('Jira returned invalid JSON') })
    const parsed = schema.safeParse(json)
    if (!parsed.success) throw new Error('Jira returned an invalid response')
    return parsed.data
  }
  issue(id: string): Promise<JiraIssue> {
    return this.request(JiraIssueSchema, `issue/${encodeURIComponent(id)}?fields=summary,description,project`)
  }
  myself() { return this.request(z.looseObject({ accountId: z.string() }), 'myself') }
  comments(id: string, startAt = 0) {
    return this.request(JiraCommentsPage, `issue/${encodeURIComponent(id)}/comment?startAt=${startAt}&maxResults=100&orderBy=created&expand=properties`)
  }
  async *allComments(id: string) {
    let startAt = 0
    for (let pages = 0; pages < 1000; pages++) {
      const page = await this.comments(id, startAt)
      for (const comment of page.comments) yield comment
      const next = page.startAt + page.comments.length
      if (next >= page.total) return
      if (!page.comments.length || next <= startAt) throw new Error('Jira comment pagination did not advance')
      startAt = next
    }
    throw new Error('Jira comment pagination exceeded its limit')
  }
  async *issues(project: string, since: number) {
    let nextPageToken: string | undefined
    const seen = new Set<string>()
    for (let pages = 0; pages < 1000; pages++) {
      const page = await this.request(SearchPage, 'search/jql', { jql: `project = "${project}" AND updated >= ${since} ORDER BY updated ASC, key ASC`,
        fields: ['summary', 'description', 'project'], maxResults: 100, ...nextPageToken ? { nextPageToken } : {} })
      for (const issue of page.issues) yield issue
      if (page.isLast === true || (!page.nextPageToken && page.isLast !== false)) return
      if (!page.nextPageToken || seen.has(page.nextPageToken)) throw new Error('Jira issue pagination did not advance')
      seen.add(page.nextPageToken)
      nextPageToken = page.nextPageToken
    }
    throw new Error('Jira issue pagination exceeded its limit')
  }
}
