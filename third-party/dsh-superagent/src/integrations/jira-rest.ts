import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Sanitized failures retained in tool results without credential or remote response values. */
export class JiraRestError extends HarnessError {
  constructor(message: string) { super(message, 'JIRA_REST_ERROR') }
}

/** Credentials are environment-variable references, never inline secrets. */
export interface JiraRestConfig {
  site: string
  cloudId: string
  emailEnv: string
  tokenEnv: string
}

interface SearchArgs { jql: string; maxResults?: number; nextPageToken?: string }
interface IssueArgs { issueIdOrKey: string }
interface PageArgs extends IssueArgs { startAt?: number; maxResults?: number }
type JsonRecord = Record<string, unknown>

const searchFields = 'summary,status,assignee,project,updated'
const issueFields = 'summary,description,status,assignee,project,updated'
const timeoutMs = 30_000
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Check the original string, not URL.port: URL parsing hides an explicit :443.
const siteOrigin = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+atlassian\.net\/?$/i

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Validate without including rejected values (which may contain secrets) in errors. */
export function validateJiraRestConfig(config: unknown): JiraRestConfig {
  if (!record(config) || Object.keys(config).some(key => !['site', 'cloudId', 'emailEnv', 'tokenEnv'].includes(key))) {
    throw new JiraRestError('Invalid Jira REST configuration.')
  }
  const { site, cloudId, emailEnv, tokenEnv } = config
  if ([site, cloudId, emailEnv, tokenEnv].some(value => typeof value === 'string' && value !== value.trim())) {
    throw new JiraRestError('Invalid Jira REST configuration.')
  }
  if (typeof site !== 'string' || !siteOrigin.test(site)) throw new JiraRestError('Invalid Jira REST site origin.')
  if (typeof cloudId !== 'string' || !uuid.test(cloudId)) throw new JiraRestError('Invalid Jira REST cloud ID.')
  if (typeof emailEnv !== 'string' || !envName.test(emailEnv) || typeof tokenEnv !== 'string' || !envName.test(tokenEnv)) {
    throw new JiraRestError('Invalid Jira REST credential environment-variable names.')
  }
  return { site, cloudId, emailEnv, tokenEnv }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new JiraRestError(`Invalid Jira REST ${name}.`)
  return value.trim()
}

function integer(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new JiraRestError(`Invalid Jira REST ${name}.`)
  }
  return value
}

function argsRecord(args: unknown): asserts args is JsonRecord {
  if (!record(args)) throw new JiraRestError('Invalid Jira REST arguments.')
}

function issuePath(args: IssueArgs): string {
  argsRecord(args)
  const key = requiredString(args.issueIdOrKey, 'issue ID or key')
  // Dot segments normalize even when percent-encoded. Other separators are encoded below.
  if (key === '.' || key === '..' || /[\u0000-\u001f\u007f]/.test(key)) throw new JiraRestError('Invalid Jira REST issue ID or key.')
  try { return `issue/${encodeURIComponent(key)}` } catch { throw new JiraRestError('Invalid Jira REST issue ID or key.') }
}

function credential(name: string): string {
  const value = process.env[name]
  if (typeof value !== 'string' || /[\r\n]/.test(value) || !value.trim()) throw new JiraRestError('Jira REST credentials are missing or invalid.')
  return value.trim()
}

/** Standalone read-only client. The configured site is never a request destination. */
export class JiraRestClient {
  private readonly config: JiraRestConfig

  constructor(config: JiraRestConfig) {
    this.config = validateJiraRestConfig(config)
  }

  async search(args: SearchArgs, signal?: AbortSignal): Promise<JsonRecord> {
    argsRecord(args)
    const params = new URLSearchParams({
      jql: requiredString(args.jql, 'JQL'),
      maxResults: String(integer(args.maxResults, 10, 1, 100, 'maxResults')),
      fields: searchFields,
    })
    if (args.nextPageToken !== undefined) params.set('nextPageToken', requiredString(args.nextPageToken, 'nextPageToken'))
    return this.request('search/jql', params, signal)
  }

  async issue(args: IssueArgs, signal?: AbortSignal): Promise<JsonRecord> {
    return this.request(issuePath(args), new URLSearchParams({ fields: issueFields }), signal)
  }

  async comments(args: PageArgs, signal?: AbortSignal): Promise<JsonRecord> {
    return this.page('comment', args, signal)
  }

  async history(args: PageArgs, signal?: AbortSignal): Promise<JsonRecord> {
    return this.page('changelog', args, signal)
  }

  private async page(resource: 'comment' | 'changelog', args: PageArgs, signal?: AbortSignal): Promise<JsonRecord> {
    const path = `${issuePath(args)}/${resource}`
    const params = new URLSearchParams({
      startAt: String(integer(args.startAt, 0, 0, Number.MAX_SAFE_INTEGER, 'startAt')),
      maxResults: String(integer(args.maxResults, 20, 1, 100, 'maxResults')),
    })
    return this.request(path, params, signal)
  }

  private async request(path: string, params: URLSearchParams, signal?: AbortSignal): Promise<JsonRecord> {
    if (signal?.aborted) throw new JiraRestError('Jira REST request aborted.')
    const email = credential(this.config.emailEnv), token = credential(this.config.tokenEnv)
    const url = `https://api.atlassian.com/ex/jira/${this.config.cloudId}/rest/api/3/${path}?${params}`
    const controller = new AbortController()
    let timedOut = false
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    timer.unref?.()
    // Racing also bounds response parsing and fetch implementations that ignore abort.
    let rejectAbort: (() => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new JiraRestError('Jira REST request aborted.'))
      controller.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    try {
      const result = (async () => {
        let response: Response
        try {
          response = await fetch(url, {
            method: 'GET', redirect: 'error', signal: controller.signal,
            headers: { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${email}:${token}`, 'utf8').toString('base64')}` },
          })
        } catch { throw new JiraRestError('Jira REST network request failed.') }
        if (response.redirected || (response.status >= 300 && response.status < 400) || !response.ok) {
          // Do not read error bodies, but release their connection when possible.
          try { await response.body?.cancel() } catch { /* Never expose upstream cancellation errors. */ }
          if (response.redirected || (response.status >= 300 && response.status < 400)) throw new JiraRestError('Jira REST redirects are not allowed.')
          throw new JiraRestError(`Jira REST request failed (HTTP ${response.status}).`)
        }
        let value: unknown
        try { value = await response.json() } catch { throw new JiraRestError('Jira REST response is not valid JSON.') }
        if (!record(value)) throw new JiraRestError('Jira REST response must be a JSON object.')
        return value
      })()
      return await Promise.race([result, aborted])
    } catch (error) {
      if (controller.signal.aborted) throw new JiraRestError(timedOut ? 'Jira REST request timed out.' : 'Jira REST request aborted.')
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort)
    }
  }
}
