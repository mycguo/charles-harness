import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf } from '../src/app/source-context.ts'
import { Commands } from '../src/infra/commands.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { githubKind } from '../src/sources/github.ts'
import { JiraClient, JiraError } from '../src/sources/jira-api.ts'
import { apply, jiraKind, pollJira, runJira } from '../src/sources/jira.ts'
import { JiraConfigSchema, jiraCommand, jiraText, jiraThreadId, jiraTrigger, type JiraComment, type JiraIssue } from '../src/sources/jira-trigger.ts'
import { testDeployment } from './fixtures/deployment.ts'

const site = 'https://example.atlassian.net', now = '2026-11-03T23:00:00.000Z'
const config = JiraConfigSchema.parse({ site, email: 'agent@example.com', projects: [{ project: 'DEMO', repository: 'acme/widgets' }] })
const doc = (text: string) => ({ type: 'doc', version: 1, content: text.split('\n').map(text => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] })) })
const issue = (id = '101', project = 'DEMO'): JiraIssue => ({ id, key: `${project}-${id}`, fields: { project: { key: project }, summary: 'Fix the export', description: doc('Export is missing the date column.') } })
const comment = (id = '1', text = '/superagent fix this', author = 'alice'): JiraComment => ({ id, body: doc(text),
  author: { accountId: author, accountType: 'atlassian' }, created: now, updated: now })
const cleanup: (() => void)[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('JIRA_SUPERAGENT_TOKEN', 'test-secret') })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const close of cleanup.splice(0)) close() })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'jira-source-')), store = new Store(join(directory, 'store.sqlite'))
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  store.saveSettings(SettingsSchema.parse({ eval: { mode: 'off' }, sources: { jira: { enabled: true, config } },
    policy: { sources: { jira: { allowed: [{ id: 'alice' }] } } } }))
  const sources = new SourceRegistry(() => store.settings())
  sources.register(jiraKind); sources.register(githubKind)
  const deployment = testDeployment({ repository: 'acme/widgets' })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const executor = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }
  const outbox = { send: vi.fn(), status: () => undefined, withdraw: vi.fn() }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() }, executor, outbox })
  const receive = vi.fn((trigger: Trigger) => engine.receive(trigger))
  const deps = { store, sources, engine, commands, deployment, outbox, ready: Promise.resolve(), configured: () => true, receive }
  const ctx = sourceContextOf(deps, jiraKind)
  return { ctx, deps, store, sources, commands, deployment, receive, executor, engine, outbox }
}
type Handler = (path: string, body: Record<string, unknown> | undefined) => unknown
function api(handler?: Handler) {
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).split('/rest/api/3/')[1]!
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    const route = handler?.(path, body)
    if (route instanceof Error) throw route
    if (route instanceof Response) return route
    const value = route ?? (path === 'search/jql' ? { issues: [issue()], isLast: true }
      : path === 'myself' ? { accountId: 'agent' }
        : path.includes('/comment?') ? { startAt: 0, total: 1, comments: [comment()] }
          : path.endsWith('/comment') ? {} : issue())
    return new Response(JSON.stringify(value), { status: 200 })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const rows = (h: ReturnType<typeof fixture>) => h.store.db.prepare('SELECT value FROM trigger').all().map(row => JSON.parse(String(row.value)) as Trigger)
const message = (): OutboundMessage => ({ id: 'ack-1', kind: 'acknowledgement', channel: jiraTrigger(config, issue(), comment())!.channel!, text: 'On it. Fixing the export.' })

describe('Jira command intake', () => {
  it('requires a real command on the first nonblank line and preserves quoted ADF', () => {
    expect(jiraCommand('\n/superagent implement this')).toBe(true)
    for (const text of ['/superagent', '/superagentx do this', 'Please /superagent do this', '> /superagent do this', '```\n/superagent do this\n```', '/superagent do this\n\ndsh-superagent:ack']) expect(jiraCommand(text)).toBe(false)
    for (const type of ['blockquote', 'codeBlock', 'bulletList']) {
      const paragraph = { type: 'paragraph', content: [{ type: 'text', text: '/superagent do this' }] }
      const body = { type: 'doc', content: [{ type, content: type === 'bulletList' ? [{ type: 'listItem', content: [paragraph] }] : [paragraph] }] }
      expect(jiraTrigger(config, issue(), { ...comment(), body })).toBeUndefined()
    }
    const inline = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '/superagent do this', marks: [{ type: 'code' }] }] }] }
    expect(jiraCommand(jiraText(inline))).toBe(false)
    expect(jiraTrigger(config, issue(), { ...comment(), visibility: { type: 'role', value: 'Developers' } })).toBeUndefined()
    expect(jiraTrigger(config, issue(), { ...comment(), author: { accountId: 'app', accountType: 'app' } })).toBeUndefined()
    expect(jiraTrigger(config, issue(), { ...comment(), properties: [{ key: 'dsh-superagent', value: {} }] })).toBeUndefined()
    expect(jiraTrigger(config, issue(), { ...comment(), created: '2026-11-03T22:00:00Z' })).toBeUndefined()
  })
  it('routes an allowed command in off mode to a worker with the mapped repository and Jira reply channel', async () => {
    const h = fixture(); api()
    await pollJira(h.ctx)
    const trigger = rows(h)[0]!
    expect(trigger).toMatchObject({ actor: { source: 'jira', id: 'alice' }, addressed: 'mention', meta: { repository: 'acme/widgets', issueKey: 'DEMO-101' } })
    expect(trigger.text).toContain('Export is missing the date column.')
    expect(h.commands.forRepository(String(trigger.meta.repository)).repository).toBe('acme/widgets')
    expect(githubKind.environment!.values({ deployment: h.deployment, config: githubKind.schema.parse({}), trigger }).DSH_SUPERAGENT_GITHUB_REPOSITORY).toBe('acme/widgets')
    h.engine.evaluateDue()
    expect(h.engine.candidate(trigger.id)?.strength).toBe('explicit')
    const decision = h.engine.decide(trigger.id, { kind: 'accept', title: 'Fix export', scope: 'requested fix', reason: 'requested', acknowledgement: 'On it.' })
    expect(decision.kind).toBe('accept')
    expect(h.executor.start).toHaveBeenCalledOnce()
    expect(h.outbox.send).toHaveBeenCalledWith(expect.objectContaining({ channel: trigger.channel, text: 'On it.' }))
    const ticket = h.store.tickets.get(decision.ticketId!)!
    const assignment = ticket.assignments.at(-1)!
    h.engine.assignmentStarted(ticket.id, assignment.id)
    // The same Jira issue reaches the same worker after acceptance.
    api((path) => path.includes('/comment?') ? { startAt: 0, total: 1, comments: [comment('2', '/superagent also add a test')] } : undefined)
    await pollJira(h.ctx)
    expect(h.executor.deliver).toHaveBeenCalled()
    expect(h.store.tickets.open()).toHaveLength(1)
  })
  it('filters unlisted users and edits by unlisted users before subscribed workers can receive them', async () => {
    const h = fixture(); api()
    await pollJira(h.ctx)
    const trigger = rows(h)[0]!
    const decision = h.engine.decide(trigger.id, { kind: 'accept', title: 'Fix', scope: '', reason: 'requested' })
    const ticket = h.store.tickets.get(decision.ticketId!)!
    h.engine.assignmentStarted(ticket.id, ticket.assignments.at(-1)!.id)
    h.receive.mockClear(); h.executor.deliver.mockClear()
    api(path => path.includes('/comment?') ? { startAt: 0, total: 3, comments: [comment('2', '/superagent bad', 'mallory'),
      { ...comment('3'), updateAuthor: { accountId: 'mallory', accountType: 'atlassian' } }, comment('4', 'ordinary discussion')] } : undefined)
    await pollJira(h.ctx)
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.executor.deliver).not.toHaveBeenCalled()
  })
  it('does not replay old commands, deduplicates overlap/restarts, and recognizes edited comments', async () => {
    const h = fixture()
    let comments = [comment(), { ...comment('2'), updated: '2026-11-03T22:59:59Z' }]
    api(path => path.includes('/comment?') ? { startAt: 0, total: comments.length, comments } : undefined)
    await pollJira(h.ctx)
    expect(rows(h)).toHaveLength(1)
    vi.setSystemTime(Date.parse(now) + 60_000)
    await pollJira(sourceContextOf(h.deps, jiraKind))
    expect(rows(h)).toHaveLength(1)
    comments = [{ ...comment(), updated: new Date().toISOString(), updateAuthor: comment().author, body: doc('/superagent fix an additional case') }]
    await pollJira(h.ctx)
    expect(rows(h)).toHaveLength(2)
    expect(new Set(rows(h).map(trigger => trigger.threads[0]!.id)).size).toBe(1)
  })
  it('paginates search and comments and retries a failed page without losing the cursor', async () => {
    const h = fixture()
    let fail = true
    const fetcher = api((path, body) => {
      if (path === 'search/jql') return body?.nextPageToken ? { issues: [issue('102')], isLast: true }
        : { issues: [issue()], isLast: false, nextPageToken: 'page2' }
      if (path.includes('/comment?')) {
        if (path.includes('startAt=1')) {
          if (fail) return new Response('private error body', { status: 503 })
          return { startAt: 1, total: 2, comments: [comment('2')] }
        }
        return { startAt: 0, total: 2, comments: [comment()] }
      }
    })
    await expect(pollJira(h.ctx)).rejects.toThrow('Jira HTTP 503')
    const saved = h.store.get(h.store.keys({ prefix: 'jira-cursor:' } as never)[0]!)
    vi.setSystemTime(Date.parse(now) + 60_000)
    fail = false
    await pollJira(h.ctx)
    expect(rows(h)).toHaveLength(4)
    expect(new Set(rows(h).map(trigger => trigger.id)).size).toBe(4)
    expect(h.store.get(h.store.keys({ prefix: 'jira-cursor:' } as never)[0]!)).not.toEqual(saved)
    expect(fetcher.mock.calls.some(([, init]) => String(init?.body).includes('page2'))).toBe(true)
  })
  it('rejects unwatched mappings and stops without advancing when configuration changes', async () => {
    const h = fixture(); const fetcher = api()
    h.store.saveSettings({ ...h.store.settings(), sources: { jira: { enabled: true, config: { ...config, projects: [{ project: 'DEMO', repository: 'acme/unwatched' }] } } } })
    await expect(pollJira(h.ctx)).rejects.toThrow('Repository is not configured')
    expect(fetcher).not.toHaveBeenCalled()
    h.store.saveSettings({ ...h.store.settings(), sources: { jira: { enabled: true, config } } })
    api(path => {
      if (path.includes('/comment?')) h.store.saveSettings({ ...h.store.settings(), sources: { jira: { enabled: false, config } } })
    })
    await pollJira(h.ctx)
    expect(h.receive).not.toHaveBeenCalled()
    expect(jiraKind.scope!({ meta: jiraTrigger(config, issue(), comment())!.meta }, { ...config, projects: [] }).listened).toBe(false)
    expect(jiraThreadId(site, '101', 'DEMO', 'acme/widgets')).not.toBe(jiraThreadId('https://other.atlassian.net', '101', 'DEMO', 'acme/widgets'))
  })
  it('isolates a moved issue from its previous project and repository worker', async () => {
    const h = fixture()
    const mappings = { ...config, projects: [...config.projects, { project: 'OTHER', repository: 'acme/widgets' }] }
    h.store.saveSettings({ ...h.store.settings(), sources: { jira: { enabled: true, config: mappings } } })
    const first = jiraTrigger(mappings, issue(), comment())!
    h.engine.receive(first)
    const decision = h.engine.decide(first.id, { kind: 'accept', title: 'Fix', scope: '', reason: 'requested' })
    const ticket = h.store.tickets.get(decision.ticketId!)!
    h.engine.assignmentStarted(ticket.id, ticket.assignments.at(-1)!.id)
    h.executor.deliver.mockClear()
    const moved = jiraTrigger(mappings, issue('101', 'OTHER'), comment('2'))!
    h.engine.receive(moved)
    h.engine.evaluateDue()
    expect(moved.channel!.thread).not.toBe(first.channel!.thread)
    expect(h.engine.candidate(moved.id)?.strength).toBe('explicit')
    expect(h.executor.deliver).not.toHaveBeenCalled()
    expect(h.commands.forRepository(String(moved.meta.repository)).repository).toBe('acme/widgets')
    expect(jiraThreadId(site, '101', 'DEMO', 'acme/widgets')).not.toBe(jiraThreadId(site, '101', 'DEMO', 'other/tools'))
  })
})

describe('Jira transport and source lifecycle', () => {
  it('keeps its Source registration until the polling task settles during disposal', async () => {
    const h = fixture()
    let ready!: () => void
    const pending = new Promise<void>(resolve => { ready = resolve })
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    const disposers: (() => Promise<void>)[] = []
    apply({ orchestrator: { sources, context: () => ({ ...h.ctx, ready: pending }) },
      effect: (effect: () => () => Promise<void>) => { disposers.push(effect()) } } as never)
    const stopped = disposers[0]!()
    expect(sources.kind('jira')).toBe(jiraKind)
    ready()
    await stopped
    expect(sources.kind('jira')).toBeUndefined()
  })
  it('posts the original issue reply with a marker and recovers from a lost POST response', async () => {
    const h = fixture(), posted: JiraComment[] = []
    let posts = 0
    api((path, body) => {
      if (path.includes('/comment?')) return { startAt: 0, total: posted.length, comments: posted }
      if (path.endsWith('/comment')) {
        posts++
        posted.push({ ...comment('9'), body: body!.body, author: { accountId: 'agent', accountType: 'atlassian' }, properties: body!.properties as JiraComment['properties'] })
        return new Error('connection reset after POST')
      }
    })
    await expect(h.sources.send(message(), h.commands)).rejects.toThrow('connection reset')
    expect(await h.sources.send(message(), h.commands)).toBe('sent')
    expect(posts).toBe(1)
    expect(jiraTrigger(config, issue(), posted[0]!)).toBeUndefined()
    expect(jiraText(posted[0]!.body)).toContain(message().text)
    expect(await h.sources.send({ ...message(), channel: { ...message().channel, address: { ...message().channel.address, site: 'https://other.atlassian.net' } } }, h.commands)).toBe('gone')
  })
  it('bounds context pages, excludes restricted comments, and refuses issues moved out of scope', async () => {
    const h = fixture()
    api(path => path.includes('/comment?') ? { startAt: 0, total: 3, comments: [comment(), { ...comment('2'), visibility: { type: 'role' } }] } : undefined)
    const trigger = jiraTrigger(config, issue(), comment())!, context = h.sources.threadContext(trigger)!
    const page = await context.read(h.commands, 'thread')
    expect(page).toMatchObject({ body: { description: 'Export is missing the date column.' }, next: '2', messages: [{ id: '1' }] })
    await expect(context.read(h.commands, 'thread', 'bad')).rejects.toThrow('Invalid Jira comment cursor')
    api(path => path.startsWith('issue/101?') ? issue('101', 'OTHER') : undefined)
    await expect(context.read(h.commands, 'root')).rejects.toThrow('moved outside')
    expect(await h.sources.send(message(), h.commands)).toBe('gone')
  })
  it('supports scoped tokens without exposing tokens or remote error bodies', async () => {
    const fetcher = api(() => new Response('private data and test-secret', { status: 429, headers: { 'Retry-After': '123' } }))
    const client = new JiraClient({ ...config, cloudId: '11111111-2222-3333-4444-555555555555' })
    await expect(client.myself()).rejects.toMatchObject({ message: 'Jira HTTP 429', retryMs: 123000 })
    expect(fetcher.mock.calls[0]![0]).toBe('https://api.atlassian.com/ex/jira/11111111-2222-3333-4444-555555555555/rest/api/3/myself')
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: 'error', headers: { Authorization: `Basic ${Buffer.from('agent@example.com:test-secret').toString('base64')}` } })
    vi.stubEnv('JIRA_SUPERAGENT_TOKEN', '')
    await expect(client.myself()).rejects.toThrow('JIRA_SUPERAGENT_TOKEN environment variable')
    expect(new JiraError(401).message).not.toContain('test-secret')
  })
  it('honors Retry-After and disposes the optional plugin cleanly', async () => {
    const h = fixture(), controller = new AbortController()
    const fetcher = api(() => new Response('', { status: 429, headers: { 'Retry-After': '200' } }))
    const running = runJira(h.ctx, controller.signal)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(199_000)
    expect(fetcher).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetcher).toHaveBeenCalledTimes(2)
    controller.abort(); await running
    const disposers: (() => unknown)[] = [], sources = new SourceRegistry(() => SettingsSchema.parse({}))
    apply({ orchestrator: { sources, context: () => ({ ...h.ctx, config: () => undefined }) },
      effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    expect(sources.kind('jira')).toBe(jiraKind)
    for (const dispose of disposers.reverse()) await dispose()
    expect(sources.kind('jira')).toBeUndefined()
  })
})
