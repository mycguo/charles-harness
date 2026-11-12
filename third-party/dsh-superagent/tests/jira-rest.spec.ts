import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JiraRestClient, validateJiraRestConfig, type JiraRestConfig } from '../src/integrations/jira-rest.ts'

const config: JiraRestConfig = {
  site: 'https://kareo.atlassian.net',
  cloudId: '12345678-1234-1234-abcd-1234567890ab',
  emailEnv: 'JIRA_REST_TEST_EMAIL',
  tokenEnv: 'JIRA_REST_TEST_TOKEN',
}
const gateway = `https://api.atlassian.com/ex/jira/${config.cloudId}/rest/api/3/`
const email = 'agent@example.com', token = 'private-test-token'
const fetcher = vi.fn<typeof fetch>()
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
const client = () => new JiraRestClient(config)
function call(index = 0) {
  const [input, init] = fetcher.mock.calls[index]!
  return { url: new URL(String(input)), init: init! }
}

beforeEach(() => {
  vi.stubEnv(config.emailEnv, email)
  vi.stubEnv(config.tokenEnv, token)
  fetcher.mockReset().mockImplementation(async () => json({ ok: true }))
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('Jira REST read-only requests', () => {
  it('fetches an issue from the gateway with only the requested issue fields', async () => {
    const issue = { id: '10', key: 'KAR-10', fields: { summary: 'A task' } }
    fetcher.mockResolvedValueOnce(json(issue))
    await expect(client().issue({ issueIdOrKey: 'KAR-10' })).resolves.toEqual(issue)
    const { url, init } = call()
    expect(url.origin).toBe('https://api.atlassian.com')
    expect(url.href).toBe(`${gateway}issue/KAR-10?fields=summary%2Cdescription%2Cstatus%2Cassignee%2Cproject%2Cupdated`)
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
    expect(init.body).toBeUndefined()
    expect(new Headers(init.headers).get('accept')).toBe('application/json')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('searches with default fields and limit, and round-trips encoded JQL and page tokens', async () => {
    const rest = client(), jql = 'project = "KAR" AND summary ~ "a & b? # +/"'
    const page = { issues: [{ key: 'KAR-1' }], nextPageToken: 'next+/=&?#' }
    fetcher.mockResolvedValueOnce(json(page))
    await expect(rest.search({ jql })).resolves.toEqual(page)
    expect(call().url.pathname).toBe(`/ex/jira/${config.cloudId}/rest/api/3/search/jql`)
    expect(Object.fromEntries(call().url.searchParams)).toEqual({ jql, maxResults: '10', fields: 'summary,status,assignee,project,updated' })
    await rest.search({ jql, maxResults: 100, nextPageToken: 'next+/=&?#' })
    expect(call(1).url.searchParams.get('nextPageToken')).toBe('next+/=&?#')
    expect(call(1).url.searchParams.get('jql')).toBe(jql)
    expect(call(1).url.searchParams.get('maxResults')).toBe('100')
    expect(call(1).url.searchParams.has('startAt')).toBe(false)
  })

  it.each(['comments', 'history'] as const)('reads %s with defaults and explicit pagination', async (method) => {
    const rest = client(), resource = method === 'comments' ? 'comment' : 'changelog'
    const result = method === 'comments' ? { comments: [], total: 0 } : { values: [], total: 0 }
    fetcher.mockResolvedValueOnce(json(result))
    await expect(rest[method]({ issueIdOrKey: '10010' })).resolves.toEqual(result)
    expect(call().url.href).toBe(`${gateway}issue/10010/${resource}?startAt=0&maxResults=20`)
    await rest[method]({ issueIdOrKey: 'KAR-10', startAt: 40, maxResults: 100 })
    expect(call(1).url.href).toBe(`${gateway}issue/KAR-10/${resource}?startAt=40&maxResults=100`)
  })

  it('uses GET without a body for every operation', async () => {
    const rest = client()
    await rest.search({ jql: 'project=KAR' })
    await rest.issue({ issueIdOrKey: 'KAR-1' })
    await rest.comments({ issueIdOrKey: 'KAR-1' })
    await rest.history({ issueIdOrKey: 'KAR-1' })
    for (let i = 0; i < 4; i++) {
      expect(call(i).init.method).toBe('GET')
      expect(call(i).init.body).toBeUndefined()
      expect(call(i).url.href.startsWith(gateway)).toBe(true)
    }
  })

  it('encodes issue IDs as one segment to prevent path and query injection', async () => {
    const key = 'KAR/../../other?fields=secret#fragment&x=1'
    const rest = client()
    await rest.issue({ issueIdOrKey: key })
    await rest.comments({ issueIdOrKey: key })
    await rest.history({ issueIdOrKey: key })
    for (let i = 0; i < 3; i++) {
      expect(call(i).url.pathname).toContain(`/issue/${encodeURIComponent(key)}`)
      expect(call(i).url.hash).toBe('')
      expect(call(i).url.searchParams.has('x')).toBe(false)
    }
  })

  it('reads and trims credentials per request, including after construction', async () => {
    vi.stubEnv(config.emailEnv, undefined)
    vi.stubEnv(config.tokenEnv, undefined)
    const rest = client()
    vi.stubEnv(config.emailEnv, `  ${email}  `)
    vi.stubEnv(config.tokenEnv, `\t ${token} \t`)
    await rest.issue({ issueIdOrKey: 'KAR-1' })
    expect(new Headers(call().init.headers).get('authorization')).toBe(`Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`)
    vi.stubEnv(config.emailEnv, 'new@example.com')
    vi.stubEnv(config.tokenEnv, 'rotated-secret')
    await rest.issue({ issueIdOrKey: 'KAR-2' })
    expect(new Headers(call(1).init.headers).get('authorization')).toBe(`Basic ${Buffer.from('new@example.com:rotated-secret').toString('base64')}`)
  })

  it('copies config so later mutation cannot redirect requests or change env references', async () => {
    const mutable = { ...config }, rest = new JiraRestClient(mutable)
    mutable.cloudId = 'evil'; mutable.emailEnv = 'OTHER_EMAIL'; mutable.site = 'https://evil.example'
    await rest.issue({ issueIdOrKey: 'KAR-1' })
    expect(call().url.href.startsWith(gateway)).toBe(true)
  })
})

describe('Jira REST config validation', () => {
  it('returns a validated copy and accepts only environment variable references', () => {
    expect(validateJiraRestConfig(config)).toEqual(config)
    expect(validateJiraRestConfig(config)).not.toBe(config)
    expect(validateJiraRestConfig({ ...config, site: `${config.site}/` }).site).toBe(`${config.site}/`)
  })
  it.each([
    'http://kareo.atlassian.net', 'https://atlassian.net', 'https://evil.example',
    'https://kareo.atlassian.net.evil.example', 'https://user:secret@kareo.atlassian.net',
    'https://kareo.atlassian.net:443', 'https://kareo.atlassian.net:8443',
    'https://kareo.atlassian.net/path', 'https://kareo.atlassian.net?x=1',
    'https://kareo.atlassian.net#hash', 'https://kareo.atlassian.net?', 'https://kareo.atlassian.net#',
    'https://kareo.atlassian.net\n', ' https://kareo.atlassian.net',
    'https://-kareo.atlassian.net', 'https://kareo_.atlassian.net',
  ])('rejects non-origin or non-Atlassian site %j', site => {
    expect(() => validateJiraRestConfig({ ...config, site })).toThrow('Invalid Jira REST')
  })
  it.each([null, [], {}, { ...config, cloudId: 'not-a-uuid' }, { ...config, cloudId: `${config.cloudId}\n` },
    { ...config, cloudId: '../secret' }, { ...config, emailEnv: email }, { ...config, tokenEnv: 'secret-value' },
    { ...config, tokenEnv: '1BAD' }, { ...config, emailEnv: '' }, { ...config, tokenEnv: 'TOKEN\n' },
    { ...config, email }, { ...config, token }, { ...config, site: 12 }, { ...config, cloudId: null },
  ])('rejects invalid configuration without echoing its values', value => {
    expect(() => validateJiraRestConfig(value)).toThrow(/^Invalid Jira REST/)
    try { validateJiraRestConfig(value) } catch (error) {
      expect(String(error)).not.toContain(email)
      expect(String(error)).not.toContain(token)
    }
    expect(() => new JiraRestClient(value as JiraRestConfig)).toThrow()
  })
})

describe('Jira REST argument and credential validation', () => {
  it.each([undefined, null, [], {}, { jql: '' }, { jql: '  ' }, { jql: 12 },
    { jql: 'x', nextPageToken: '' }, { jql: 'x', nextPageToken: 1 },
  ])('rejects invalid search arguments %j before fetching', async args => {
    await expect(client().search(args as never)).rejects.toThrow('Invalid Jira REST')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each([0, -1, 101, 1.5, NaN, Infinity, '10', null])('rejects invalid maxResults %j for every paginated method', async maxResults => {
    const rest = client()
    await expect(rest.search({ jql: 'x', maxResults: maxResults as number })).rejects.toThrow('maxResults')
    for (const method of ['comments', 'history'] as const) {
      await expect(rest[method]({ issueIdOrKey: 'KAR-1', maxResults: maxResults as number })).rejects.toThrow('maxResults')
    }
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null])('rejects invalid offsets %j', async startAt => {
    for (const method of ['comments', 'history'] as const) {
      await expect(client()[method]({ issueIdOrKey: 'KAR-1', startAt: startAt as number })).rejects.toThrow('startAt')
    }
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each([undefined, null, [], {}, { issueIdOrKey: '' }, { issueIdOrKey: '  ' }, { issueIdOrKey: 1 },
    { issueIdOrKey: '.' }, { issueIdOrKey: '..' }, { issueIdOrKey: 'KAR\r\n1' }, { issueIdOrKey: '\ud800' },
  ])('rejects invalid issue arguments %j', async args => {
    for (const method of ['issue', 'comments', 'history'] as const) await expect(client()[method](args as never)).rejects.toThrow('Invalid Jira REST')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each([undefined, '', '  ', '\rsecret', 'secret\n', 'sec\r\nret'])('rejects absent, blank or CRLF credentials %j', async value => {
    for (const name of [config.emailEnv, config.tokenEnv]) {
      vi.stubEnv(config.emailEnv, email); vi.stubEnv(config.tokenEnv, token)
      vi.stubEnv(name, value)
      await expect(client().issue({ issueIdOrKey: 'KAR-1' })).rejects.toThrow('Jira REST credentials are missing or invalid.')
    }
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('Jira REST sanitized failures and cancellation', () => {
  const upstreamSecret = `${email} ${token} https://secret.example/?token=secret Authorization: Basic hidden`
  it.each([301, 302, 307, 308])('refuses redirect status %i without following or exposing location', async status => {
    fetcher.mockResolvedValueOnce(new Response(upstreamSecret, { status, headers: { location: 'https://secret.example' } }))
    await expect(client().issue({ issueIdOrKey: 'KAR-1' })).rejects.toThrow('Jira REST redirects are not allowed.')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(call().init.redirect).toBe('error')
  })
  it('rejects a response that claims a redirect was followed', async () => {
    const response = json({}); Object.defineProperty(response, 'redirected', { value: true })
    fetcher.mockResolvedValueOnce(response)
    await expect(client().issue({ issueIdOrKey: 'KAR-1' })).rejects.toThrow('Jira REST redirects are not allowed.')
  })
  it.each([401, 403, 404, 429, 500])('sanitizes HTTP %i without reading its body or headers', async status => {
    const response = new Response(upstreamSecret, { status, statusText: 'secret upstream status', headers: { 'x-secret': token } })
    const body = vi.spyOn(response, 'json'), cancel = vi.spyOn(response.body!, 'cancel')
    fetcher.mockResolvedValueOnce(response)
    await expect(client().issue({ issueIdOrKey: 'KAR-1' })).rejects.toThrow(`Jira REST request failed (HTTP ${status}).`)
    expect(body).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('does not expose failures while releasing an HTTP error response body', async () => {
    const response = new Response(upstreamSecret, { status: 403 })
    vi.spyOn(response.body!, 'cancel').mockRejectedValueOnce(new Error(upstreamSecret))
    fetcher.mockResolvedValueOnce(response)
    await expect(client().issue({ issueIdOrKey: 'KAR-1' })).rejects.toThrow('Jira REST request failed (HTTP 403).')
  })
  it('replaces network and redirect-policy errors instead of exposing them or their causes', async () => {
    fetcher.mockRejectedValueOnce(new TypeError(upstreamSecret))
    const error = await client().search({ jql: 'x' }).catch(error => error as Error)
    expect(error.message).toBe('Jira REST network request failed.')
    expect(error.cause).toBeUndefined()
    expect(error.stack).not.toContain(token)
  })
  it('sanitizes invalid JSON and response body read failures', async () => {
    fetcher.mockResolvedValueOnce(new Response(upstreamSecret, { status: 200 }))
    await expect(client().issue({ issueIdOrKey: 'KAR-1' })).rejects.toThrow('Jira REST response is not valid JSON.')
    const response = json({})
    vi.spyOn(response, 'json').mockRejectedValueOnce(new Error(upstreamSecret))
    fetcher.mockResolvedValueOnce(response)
    await expect(client().issue({ issueIdOrKey: 'KAR-1' })).rejects.toThrow('Jira REST response is not valid JSON.')
  })
  it.each([null, [], 'secret upstream value', 1, true])('rejects non-record JSON shape %j', async value => {
    fetcher.mockResolvedValueOnce(json(value))
    await expect(client().issue({ issueIdOrKey: 'KAR-1' })).rejects.toThrow('Jira REST response must be a JSON object.')
  })
  it('rejects pre-aborted caller signals without issuing a request or exposing abort reasons', async () => {
    const controller = new AbortController(); controller.abort(new Error(upstreamSecret))
    await expect(client().issue({ issueIdOrKey: 'KAR-1' }, controller.signal)).rejects.toThrow('Jira REST request aborted.')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each(['search', 'issue', 'comments', 'history'] as const)('passes cancellation through %s even if fetch ignores its signal', async method => {
    fetcher.mockImplementationOnce(() => new Promise(() => {}))
    const controller = new AbortController(), rest = client()
    const promise = method === 'search' ? rest.search({ jql: 'x' }, controller.signal) : rest[method]({ issueIdOrKey: 'KAR-1' }, controller.signal)
    const assertion = expect(promise).rejects.toThrow('Jira REST request aborted.')
    controller.abort(new Error(upstreamSecret))
    await assertion
    expect(call().init.signal?.aborted).toBe(true)
  })
  it('bounds requests to 30 seconds and cleans its timer after completion', async () => {
    vi.useFakeTimers()
    fetcher.mockImplementationOnce(() => new Promise(() => {}))
    const promise = client().issue({ issueIdOrKey: 'KAR-1' })
    const assertion = expect(promise).rejects.toThrow('Jira REST request timed out.')
    await vi.advanceTimersByTimeAsync(29_999)
    expect(call().init.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await assertion
    expect(call().init.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    await client().issue({ issueIdOrKey: 'KAR-2' })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds JSON parsing as well as the initial fetch', async () => {
    vi.useFakeTimers()
    const response = json({})
    vi.spyOn(response, 'json').mockImplementationOnce(() => new Promise(() => {}))
    fetcher.mockResolvedValueOnce(response)
    const promise = client().issue({ issueIdOrKey: 'KAR-1' })
    const assertion = expect(promise).rejects.toThrow('Jira REST request timed out.')
    await vi.advanceTimersByTimeAsync(30_000)
    await assertion
  })
})
