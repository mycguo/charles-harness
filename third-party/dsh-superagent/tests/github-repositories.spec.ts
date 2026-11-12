import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Engine, type OutboundMessage, type Ticket, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf } from '../src/app/source-context.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, settingsPolicy, policyVersion } from '../src/policy.ts'
import { githubKind, pollRound } from '../src/sources/github.ts'
import { sendGithub } from '../src/sources/github-channel.ts'
import { claimPull, type Pull } from '../src/sources/github-pull.ts'
import { repositoryContext, triggerRepository } from '../src/sources/github-repository.ts'
import { readGithub } from '../src/sources/github-read.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testDeployment } from './fixtures/deployment.ts'

const first = 'acme/widgets', second = 'other/tools'
const cleanup: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) close() })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'github-repositories-'))
  const store = new Store(join(directory, 'store.sqlite'))
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  store.saveSettings(SettingsSchema.parse({ eval: { mode: 'auto' }, policy: { sources: { github: { allowed: [{ id: 'alice' }] } } },
    sources: { github: { enabled: true, config: { repository: first, repositories: [{ id: first }, { id: second }], allowSelfRequests: true } } } }))
  const board = new HealthBoard(), sources = new SourceRegistry(() => store.settings(), board)
  sources.register(githubKind)
  const deployment = testDeployment({ repository: first, repositories: [first, second], legacyRepository: first })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const ctx = sourceContextOf({ store, sources, engine, commands, deployment, outbox: { send: vi.fn() },
    ready: Promise.resolve(), configured: () => true, receive: trigger => engine.receive(trigger) }, githubKind)
  for (const repository of deployment.repositories!) {
    repositoryContext(ctx, repository).state.set(KV.github.stream('comments'), { since: new Date(Date.now() - 60_000).toISOString(),
      started: { comments: new Date(Date.now() - 60_000).toISOString() } })
  }
  return { ctx, store, sources, deployment, commands, board }
}
function api(failing?: string) {
  const paths: string[] = []
  vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_program, args) => {
    const path = args[1]!, match = /^repos\/([^/]+\/[^/]+)\/(.*)$/.exec(path)
    if (!match) throw new Error(`Unexpected API path: ${path}`)
    const repository = match[1]!, endpoint = match[2]!.split('?')[0]!
    paths.push(path)
    if (repository === failing) throw new Error('Temporary GitHub failure')
    const now = new Date().toISOString()
    let value: unknown = []
    if (endpoint === 'issues/comments') value = [{ id: 99, body: '/superagent fix the request', user: { login: 'alice' },
      html_url: `https://github.com/${repository}/pull/42#issuecomment-99`, issue_url: `https://api.github.com/repos/${repository}/issues/42`, created_at: now, updated_at: now }]
    if (endpoint === 'pulls/42') value = pull(repository)
    if (args.includes('--include')) return `HTTP/2.0 200 OK\r\nX-Poll-Interval: 60\r\n\r\n${JSON.stringify(value)}`
    return JSON.stringify(args.includes('--slurp') ? [value] : value)
  })
  return paths
}
function pull(repository: string): Pull {
  return { number: 42, title: 'Request', state: 'open', html_url: `https://github.com/${repository}/pull/42`,
    user: { login: 'alice' }, head: { sha: 'abc', ref: 'request', repo: { full_name: repository } } }
}
function incoming(repository: string): Trigger {
  return { id: `request-${repository}`, source: 'github', actor: { source: 'github', id: 'alice' }, human: true, addressed: 'mention',
    at: new Date().toISOString(), text: '/superagent fix the request', threads: [{ source: 'github', id: '42' }],
    channel: { source: 'github', thread: 'github:42', address: { number: '42' } }, meta: { number: 42, isPr: true, repository } }
}
function ticket(id: string, triggerId: string): Ticket {
  return { id, title: id, decisionId: `decision-${id}`, mandate: { strength: 'explicit', policyVersion: '',
    basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: '' }, channels: [], assignments: [], inputs: [],
    undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId, triggerIds: [triggerId] } }
}

it('polls repositories independently and separates equal PR numbers, cursors and deliveries', async () => {
  const h = fixture(), paths = api()
  await pollRound(h.ctx)
  const rows = h.store.db.prepare('SELECT value FROM trigger').all().map(row => JSON.parse(String(row.value)) as Trigger)
  expect(rows).toHaveLength(2)
  expect(new Set(rows.map(row => row.id)).size).toBe(2)
  expect(rows.map(row => row.meta.repository).sort()).toEqual([first, second].sort())
  expect(h.store.threads.get('github:42')).toBeDefined()
  expect(h.store.threads.get(`github:${second}#42`)).toBeDefined()
  expect(rows.find(row => row.meta.repository === second)?.channel?.address.repository).toBe(second)
  expect(h.store.get(KV.github.stream('comments'))).toBeDefined()
  repositoryContext(h.ctx, second).state.set(KV.github.stream('comments'), { since: 'other-cursor', started: {} })
  expect(h.store.get(KV.github.stream('comments'))?.since).not.toBe('other-cursor')
  expect(paths.some(path => path.startsWith(`repos/${first}/`))).toBe(true)
  expect(paths.some(path => path.startsWith(`repos/${second}/`))).toBe(true)
  expect(h.board.all.github?.state).toBe('ready')
})

it('continues polling another repository when one fails', async () => {
  const h = fixture(); api(first)
  await expect(pollRound(h.ctx)).rejects.toThrow('Temporary GitHub failure')
  expect(h.store.threads.get(`github:${second}#42`)).toBeDefined()
  expect(h.store.threads.get('github:42')).toBeUndefined()
})

it('keeps legacy identities stable after reordering/removing repositories and rejects unconfigured targets', () => {
  const h = fixture(), old = repositoryContext(h.ctx, second)
  old.state.set(KV.github.cursor(42), 'saved-cursor')
  h.deployment.repository = second; h.deployment.repositories = [second]
  const current = repositoryContext(h.ctx, second)
  expect(current.state.get(KV.github.cursor(42))).toBe('saved-cursor')
  current.receive(incoming(second))
  expect(h.store.threads.get(`github:${second}#42`)).toBeDefined()
  expect(h.store.threads.get('github:42')).toBeUndefined()
  expect(() => h.commands.forRepository(first)).toThrow('not watched')
  expect(() => triggerRepository(h.deployment, incoming(first))).toThrow('not watched')
})

it('sends a reply and prepares worker variables for the request repository instead of the default', async () => {
  const h = fixture(), paths = api()
  const message: OutboundMessage = { id: 'reply-42', kind: 'notice', text: 'Complete',
    channel: { source: 'github', thread: `github:${second}#42`, address: { repository: second, number: '42' } } }
  await sendGithub(h.ctx, message)
  expect(paths.length).toBe(2)
  expect(paths.every(path => path.startsWith(`repos/${second}/issues/42/comments`))).toBe(true)
  const values = githubKind.environment!.values({ deployment: h.deployment,
    config: githubKind.schema.parse({}), trigger: incoming(second) })
  expect(values.DSH_SUPERAGENT_GITHUB_REPOSITORY).toBe(second)
  expect(values.DSH_SUPERAGENT_GITHUB_PR_HEAD).toBe('refs/pull/42/head')
})

it('binds the same PR number to separate tickets without claiming another repository ticket', () => {
  const h = fixture()
  repositoryContext(h.ctx, first).receive(incoming(first)); repositoryContext(h.ctx, second).receive(incoming(second))
  const origins = h.store.db.prepare('SELECT value FROM trigger').all().map(row => JSON.parse(String(row.value)) as Trigger)
  for (const [index, repository] of [first, second].entries()) {
    const origin = origins.find(row => row.meta.repository === repository)!
    h.store.tickets.save(ticket(`ticket-${index}`, origin.id))
    expect(claimPull(repositoryContext(h.ctx, repository), `ticket-${index}`, pull(repository))).toBeUndefined()
  }
  expect(h.store.tickets.get('ticket-0')?.follows?.[0]?.thread).toBe('github:42')
  expect(h.store.tickets.get('ticket-1')?.follows?.[0]?.thread).toBe(`github:${second}#42`)
  expect(claimPull(repositoryContext(h.ctx, second), 'ticket-0', pull(second))).toBeDefined()
})

it('stops admitting and replying to paused repositories and scopes number references to their origin', () => {
  const h = fixture(), origin = incoming(second)
  const before = policyVersion(h.store.settings())
  const gate = settingsPolicy(h.store.settings(), h.sources).gate(origin, {} as never, [])
  expect(gate.admissible).toBe(true)
  expect(h.sources.find('#42', origin).threads).toEqual([`github:${second}#42`])
  expect(h.sources.find(`https://github.com/${first}/pull/42`, origin).threads).toEqual(['github:42'])
  const settings = h.store.settings()
  settings.sources.github!.config.repositories = [{ id: first, status: 'watch' }, { id: second, status: 'paused' }]
  h.store.saveSettings(settings)
  expect(h.sources.scope({ source: 'github', meta: origin.meta }).listened).toBe(false)
  expect(h.sources.channelAllowed({ source: 'github', address: { repository: second } })).toBe(false)
  expect(policyVersion(h.store.settings())).not.toBe(before)
  if (gate.admissible) expect(settingsPolicy(h.store.settings(), h.sources).revalidate({ strength: gate.strength, basis: gate.basis,
    actor: origin.actor, policyVersion: before, scope: '' })).toBe(false)
})

it('separates native issue IDs that are equal across repositories', () => {
  const h = fixture()
  for (const repository of [first, second]) repositoryContext(h.ctx, repository).receive({ ...incoming(repository), id: 'same-native-issue-id' })
  expect(h.store.db.prepare('SELECT count(*) AS count FROM trigger').get()?.count).toBe(2)
})

it('anchors a fresh repository list to its first watching repository when the saved list is later reordered', () => {
  const saved = githubKind.schema.parse({ repositories: [{ id: 'unused/paused', status: 'paused' }, { id: first }, { id: second }] })
  expect(saved.repository).toBe(first)
  const reordered = githubKind.schema.parse({ ...saved, repositories: [{ id: second }, { id: first }] })
  expect(githubKind.find!('#42', reordered, incoming(first)).threads).toEqual(['github:42'])
  expect(githubKind.find!('#42', reordered, incoming(second)).threads).toEqual([`github:${second}#42`])
})

it('keeps repository identity on paginated GitHub resource reads', async () => {
  const h = fixture(), paths: string[] = []
  vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_program, args) => {
    paths.push(args[1]!)
    return JSON.stringify(Array.from({ length: 20 }, (_, id) => ({ id, body: 'Text', user: { login: 'alice' } })))
  })
  const page = await readGithub(h.commands, `github/repos/${second}/issues/42/comments/1`) as { next_resource: string }
  expect(paths[0]).toContain(`repos/${second}/issues/42/comments`)
  expect(page.next_resource).toBe(`github/repos/${second}/issues/42/comments/2`)
})
