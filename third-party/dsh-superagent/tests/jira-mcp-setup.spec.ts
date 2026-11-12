/** Offline profile and MCP preflight tests; no real Jira credentials or organization changes. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseDocument } from 'yaml'

const script = join(import.meta.dirname, '..', 'scripts', 'setup-jira-mcp.mjs')
const { runSetup, REQUIRED_TOOLS, ENDPOINT } = await import(new URL('../scripts/setup-jira-mcp.mjs', import.meta.url).href)
const token = 'fake-jira-private-token'
const args = ['--email', 'operator@example.com', '--site', 'https://example.atlassian.net', '--project', 'DEMO']
const initial = `# Preserve this existing deployment.
- id: dsh-superagent
  config:
    stateDir: /existing/state
    database:
      backend: postgres
      urlFile: /private/db.env
- id: dsh-superagent-google-login
  disabled: false
  config:
    credentialsFile: /private/google.json
- id: custom
  config:
    value: !!js process.env.KEEP_ME
`
let root: string, profile: string, patch: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jira mcp setup '))
  profile = join(root, 'profiles', 'superagent')
  mkdirSync(profile, { recursive: true })
  patch = join(profile, 'cordis.patch.yml')
  writeFileSync(patch, initial)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
function host() {
  const tools = REQUIRED_TOOLS.map((name: string) => ({ name, inputSchema: { type: 'object', properties: { maxResults: { type: 'integer' } } } }))
  const client = {
    listTools: vi.fn(async () => ({ tools })),
    callTool: vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify({ issues: [{ key: 'DEMO-42' }] }) }] })),
    close: vi.fn(async () => {}),
  }
  const connect = vi.fn(async () => client)
  const deps = { environment: { DSH_HOME: root, JIRA_MYCGUO_TOKEN: token }, dotenvPath: join(root, 'checkout.env'), connect }
  return { client, tools, connect, deps, run: (...extra: string[]) => runSetup([...args, ...extra], deps) }
}
function document() {
  return parseDocument(readFileSync(patch, 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
}
const backups = () => readdirSync(profile).filter(name => name.includes('.backup-'))

it('configures the native MCP plugin without storing the token and preserves PostgreSQL, Google and expressions', async () => {
  const h = host()
  expect(await h.run()).toMatchObject({ mode: 'setup', changed: true, sample: 'DEMO-42' })
  const content = readFileSync(patch, 'utf8')
  expect(content).toContain('# Preserve this existing deployment.')
  expect(content).toContain('!!js process.env.KEEP_ME')
  expect(content).not.toContain(token)
  const rows = document().toJS()
  expect(rows.slice(0, 3)).toEqual(parseDocument(initial, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (v: string) => v }] }).toJS())
  const entry = rows.at(-1).insert[0]
  expect(entry).toMatchObject({ id: 'mcp-jira', name: '@deepseek-ai/dsh-mcp-client', disabled: false,
    config: { serverName: 'jira', transport: 'streamable-http', url: ENDPOINT, failOnStartupError: false } })
  const expression = document().getIn([3, 'insert', 0, 'config', 'headers', 'Authorization'], true) as { tag: string; value: string }
  expect(expression.tag).toBe('tag:yaml.org,2002:js')
  // Evaluate with an isolated fake process, as the host evaluates !!js; no operator environment is used.
  expect(new Function('process', 'Buffer', `return (${expression.value})`)({ env: { JIRA_MYCGUO_TOKEN: token } }, Buffer))
    .toBe(`Basic ${Buffer.from(`operator@example.com:${token}`).toString('base64')}`)
  expect(() => new Function('process', 'Buffer', `return (${expression.value})`)({ env: {} }, Buffer)).toThrow('token is missing')
  expect(h.client.callTool).toHaveBeenCalledWith({ name: 'searchJiraIssuesUsingJql', arguments: {
    cloudId: 'https://example.atlassian.net', jql: 'project = "DEMO" ORDER BY updated DESC', maxResults: 1,
  } }, expect.objectContaining({ timeout: 20_000 }))
  expect(readFileSync(join(profile, backups()[0]!), 'utf8')).toBe(initial)
  expect(statSync(join(profile, backups()[0]!)).mode & 0o777).toBe(0o600)
  expect(h.client.close).toHaveBeenCalledOnce()
})

it('is idempotent and checks the saved profile without creating more backups', async () => {
  const h = host()
  await h.run()
  const saved = readFileSync(patch, 'utf8')
  expect(await h.run()).toMatchObject({ changed: false })
  expect(await h.run('--check')).toMatchObject({ mode: 'check', project: 'DEMO' })
  expect(readFileSync(patch, 'utf8')).toBe(saved)
  expect(backups()).toHaveLength(1)
})

it('keeps personal and Kareo accounts independent through setup, checks and credential rotation', async () => {
  const h = host(), workToken = 'fake-kareo-private-token'
  const environment = h.deps.environment as Record<string, string>
  environment.JIRA_TEBRA_TOKEN = workToken
  await h.run()
  const personal = document().getIn([3, 'insert', 0], true)!.toString()
  const work = ['--server-name', 'jira_kareo', '--token-env', 'JIRA_TEBRA_TOKEN', '--email', 'operator@tebra.example',
    '--site', 'https://kareodev.atlassian.net', '--project', 'BILL']
  h.client.callTool.mockResolvedValue({ content: [{ type: 'text', text: '{"issues":[{"key":"BILL-12099"}]}' }] })
  expect(await h.run(...work)).toMatchObject({ mode: 'setup', changed: true, serverName: 'jira_kareo', entryId: 'mcp-jira_kareo',
    site: 'https://kareodev.atlassian.net', project: 'BILL', sample: 'BILL-12099' })
  expect(h.connect).toHaveBeenLastCalledWith({ email: 'operator@tebra.example', token: workToken })
  expect(h.client.callTool).toHaveBeenLastCalledWith({ name: 'searchJiraIssuesUsingJql', arguments: {
    cloudId: 'https://kareodev.atlassian.net', jql: 'project = "BILL" ORDER BY updated DESC', maxResults: 1,
  } }, expect.objectContaining({ timeout: 20_000 }))
  expect(document().getIn([3, 'insert', 0], true)!.toString()).toBe(personal)
  const rows = document().toJS()
  expect(rows[4].insert[0]).toMatchObject({ id: 'mcp-jira_kareo', name: '@deepseek-ai/dsh-mcp-client', disabled: false,
    config: { serverName: 'jira_kareo', url: ENDPOINT } })
  const auth = (index: number) => document().getIn([index, 'insert', 0, 'config', 'headers', 'Authorization']) as string
  const evaluate = (expression: string) => new Function('process', 'Buffer', `return (${expression})`)(
    { env: h.deps.environment }, Buffer)
  expect(evaluate(auth(3))).toBe(`Basic ${Buffer.from(`operator@example.com:${token}`).toString('base64')}`)
  expect(evaluate(auth(4))).toBe(`Basic ${Buffer.from(`operator@tebra.example:${workToken}`).toString('base64')}`)
  expect(readFileSync(patch, 'utf8')).not.toContain(token)
  expect(readFileSync(patch, 'utf8')).not.toContain(workToken)
  expect(await h.run(...work)).toMatchObject({ changed: false })
  expect(await h.run(...work, '--check')).toMatchObject({ mode: 'check', serverName: 'jira_kareo' })
  environment.JIRA_TEBRA_TOKEN = 'fake-rotated-work-token'
  expect(await h.run(...work)).toMatchObject({ changed: false })
  expect(h.connect).toHaveBeenLastCalledWith({ email: 'operator@tebra.example', token: 'fake-rotated-work-token' })
  expect(document().getIn([3, 'insert', 0], true)!.toString()).toBe(personal)
  expect(await h.run('--check')).toMatchObject({ mode: 'check', serverName: 'jira', entryId: 'mcp-jira' })
  expect(h.connect).toHaveBeenLastCalledWith({ email: 'operator@example.com', token })
  expect(backups()).toHaveLength(2)
})

it('requires an explicit named credential and validates namespace names before connecting', async () => {
  const h = host()
  await expect(h.run('--server-name', 'jira_kareo')).rejects.toThrow('Supply --token-env')
  for (const name of ['', '../jira', 'jira work', 'a'.repeat(33)]) {
    await expect(h.run('--server-name', name, '--token-env', 'JIRA_MYCGUO_TOKEN')).rejects.toThrow('--server-name')
  }
  expect(h.connect).not.toHaveBeenCalled()
  expect(readFileSync(patch, 'utf8')).toBe(initial)
})

it('checks the selected connection rather than treating a personal connection as the work account', async () => {
  const h = host()
  await h.run()
  h.connect.mockClear()
  await expect(h.run('--server-name', 'jira_kareo', '--token-env', 'JIRA_MYCGUO_TOKEN', '--check'))
    .rejects.toThrow('no matching active Jira MCP configuration')
  expect(h.connect).not.toHaveBeenCalled()
  expect(backups()).toHaveLength(1)
})

it('refuses named namespace and entry ownership collisions without touching the existing profile', async () => {
  const h = host(), named = ['--server-name', 'jira_kareo', '--token-env', 'JIRA_MYCGUO_TOKEN']
  for (const conflict of [
    '- id: other-mcp\n  config:\n    serverName: jira_kareo\n',
    '- id: mcp-jira_kareo\n  name: different-plugin\n',
    '- id: mcp-jira_kareo\n  name: "@deepseek-ai/dsh-mcp-client"\n  config:\n    serverName: another-server\n',
  ]) {
    const original = initial + conflict
    writeFileSync(patch, original)
    await expect(h.run(...named)).rejects.toThrow(/already used|another plugin|another server namespace/)
    expect(readFileSync(patch, 'utf8')).toBe(original)
  }
  expect(h.connect).not.toHaveBeenCalled()
  expect(backups()).toEqual([])
})

it('leaves the personal account untouched when work-account preflight fails', async () => {
  const h = host()
  await h.run()
  const original = readFileSync(patch, 'utf8')
  const environment = h.deps.environment as Record<string, string>
  environment.JIRA_TEBRA_TOKEN = 'fake-work-token'
  h.client.callTool.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'Access refused' }] } as never)
  await expect(h.run('--server-name', 'jira_kareo', '--token-env', 'JIRA_TEBRA_TOKEN', '--email', 'operator@tebra.example',
    '--site', 'https://kareodev.atlassian.net', '--project', 'BILL')).rejects.toThrow('JQL access test failed')
  expect(readFileSync(patch, 'utf8')).toBe(original)
  expect(backups()).toHaveLength(1)
})

it('probes upstream access without needing or modifying a profile', async () => {
  const h = host()
  rmSync(join(root, 'profiles'), { recursive: true })
  expect(await h.run('--probe')).toMatchObject({ mode: 'probe', sample: 'DEMO-42' })
  expect(readdirSync(root)).toEqual([])
})

it('refuses to claim a profile is connected when absent, disabled or using an unevaluated header', async () => {
  const h = host()
  await expect(h.run('--check')).rejects.toThrow('no matching active Jira MCP configuration')
  expect(h.connect).not.toHaveBeenCalled()
  await h.run()
  const configured = readFileSync(patch, 'utf8')
  writeFileSync(patch, configured.replace(/disabled: false(?=\n {6}config:)/, 'disabled: true'))
  await expect(h.run('--check')).rejects.toThrow('no matching active')
  writeFileSync(patch, configured.replace('Authorization: !!js', 'Authorization:'))
  await expect(h.run('--check')).rejects.toThrow('no matching active')
})

it('refuses search-only tokens with an actionable MCP V2 scope explanation before changing the profile', async () => {
  const h = host()
  h.client.listTools.mockResolvedValue({ tools: [{ name: 'search', inputSchema: { type: 'object', properties: { maxResults: { type: 'integer' } } } }] })
  await expect(h.run()).rejects.toThrow('Atlassian MCP V2 token')
  await expect(h.run()).rejects.toThrow('read:jira:agent-interface')
  expect(readFileSync(patch, 'utf8')).toBe(initial)
  expect(backups()).toEqual([])
  expect(h.client.callTool).not.toHaveBeenCalled()
})

it('refuses tokens advertising Jira mutation tools and refuses a failed JQL access test', async () => {
  const h = host()
  for (const name of ['transitionJiraIssue', 'addCommentToJiraIssue', 'addWorklogToJiraIssue', 'linkJiraIssues']) {
    h.tools.push({ name, inputSchema: { type: 'object', properties: { maxResults: { type: 'integer' } } } })
    await expect(h.run()).rejects.toThrow('mutation tools')
    h.tools.pop()
  }
  h.client.callTool.mockResolvedValue({ isError: true, content: [{ type: 'text', text: token }] } as never)
  await expect(h.run()).rejects.toThrow('JQL access test failed')
  expect(readFileSync(patch, 'utf8')).toBe(initial)
  expect(backups()).toEqual([])
})

it('sanitizes upstream failures and closes the client even if an error contains credentials', async () => {
  const h = host()
  h.client.listTools.mockRejectedValue(new Error(`Authorization: Basic ${token}`))
  await expect(h.run()).rejects.toThrow('No upstream error body was printed')
  await expect(h.run()).rejects.not.toThrow(token)
  expect(h.client.close).toHaveBeenCalledTimes(2)
  expect(readFileSync(patch, 'utf8')).toBe(initial)
})

it('rejects invalid sites, emails, project keys, profile traversal and credential variable names before connecting', async () => {
  const h = host()
  for (const extra of [['--site', 'https://example.com'], ['--site', 'https://example.atlassian.net/path'],
    ['--site', 'https://secret@example.atlassian.net'], ['--email', 'not-an-email'], ['--project', 'DEMO OR 1=1'],
    ['--profile', '../another'], ['--token-env', 'DSH_TOKEN'], ['--probe', '--check']]) {
    await expect(h.run(...extra)).rejects.toThrow()
  }
  expect(h.connect).not.toHaveBeenCalled()
  expect(readFileSync(patch, 'utf8')).toBe(initial)
})

it('loads dotenv as data with host environment taking precedence and supports alternate token variables', async () => {
  const h = host()
  writeFileSync(join(root, '.env'), 'JIRA_MYCGUO_TOKEN=home-token\n')
  writeFileSync(h.deps.dotenvPath, 'JIRA_MYCGUO_TOKEN=checkout-token\n')
  await h.run('--probe')
  expect(h.connect).toHaveBeenLastCalledWith({ email: 'operator@example.com', token })
  delete (h.deps.environment as Record<string, string>).JIRA_MYCGUO_TOKEN
  await h.run('--probe')
  expect(h.connect).toHaveBeenLastCalledWith({ email: 'operator@example.com', token: 'checkout-token' })
  writeFileSync(h.deps.dotenvPath, 'JIRA_MYCGUO_TOKEN=\nJIRA_OTHER_TOKEN=other-token\n')
  await expect(h.run('--probe')).rejects.toThrow('token is missing')
  await h.run('--probe', '--token-env', 'JIRA_OTHER_TOKEN')
  expect(h.connect).toHaveBeenLastCalledWith({ email: 'operator@example.com', token: 'other-token' })
})

it('preserves a concurrent profile edit and refuses an entry belonging to a different plugin', async () => {
  const h = host()
  h.connect.mockImplementation(async () => { writeFileSync(patch, initial + '# edited elsewhere\n'); return h.client })
  await expect(h.run()).rejects.toThrow('Profile changed during setup')
  expect(readFileSync(patch, 'utf8')).toContain('# edited elsewhere')
  expect(backups()).toEqual([])
  writeFileSync(patch, `${initial}- id: mcp-jira\n  name: another-plugin\n`)
  await expect(h.run()).rejects.toThrow('belongs to another plugin')
})

it('preserves custom reconnect settings and refuses a duplicate server namespace or malformed patch', async () => {
  const h = host()
  writeFileSync(patch, `${initial}- insert:
    - id: mcp-jira
      name: '@deepseek-ai/dsh-mcp-client'
      disabled: true
      config:
        reconnect:
          maxAttempts: 4
        toolCallTimeoutMs: 12000
`)
  await h.run()
  const config = document().getIn([3, 'insert', 0, 'config']) as { get: (key: string) => unknown }
  expect(config.get('toolCallTimeoutMs')).toBe(12000)
  expect(document().getIn([3, 'insert', 0, 'config', 'reconnect', 'maxAttempts'])).toBe(4)
  const collision = `${initial}- id: another-mcp\n  config:\n    serverName: jira\n`
  writeFileSync(patch, collision)
  await expect(h.run()).rejects.toThrow('already used')
  expect(readFileSync(patch, 'utf8')).toBe(collision)
  writeFileSync(patch, '[invalid YAML')
  await expect(h.run()).rejects.toThrow('valid YAML entry list')
  expect(readFileSync(patch, 'utf8')).toBe('[invalid YAML')
})

it('supports paginated discovery and detects repeated cursors without sending tool calls', async () => {
  const h = host()
  h.client.listTools.mockResolvedValueOnce({ tools: h.tools.slice(0, 2), nextCursor: 'page2' } as never)
    .mockResolvedValueOnce({ tools: h.tools.slice(2) })
  await h.run('--probe')
  expect(h.client.listTools).toHaveBeenNthCalledWith(2, { cursor: 'page2' }, expect.anything())
  h.client.listTools.mockResolvedValue({ tools: [], nextCursor: 'repeat' } as never)
  h.client.callTool.mockClear()
  await expect(h.run('--probe')).rejects.toThrow('invalid tool-list cursor')
  expect(h.client.callTool).not.toHaveBeenCalled()
})

it('shows CLI help without contacting Jira or requiring credentials', () => {
  const output = execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' })
  expect(output).toContain('--probe')
  expect(output).toContain('--check')
  expect(output).toContain('--server-name')
  expect(output).not.toContain(token)
})

it('runs preflight through the real SDK HTTP transport, authentication and schema validation', async () => {
  const calls: { method: string; authorization?: string; params?: Record<string, unknown> }[] = []
  const tools = REQUIRED_TOOLS.map((name: string) => ({ name, description: name, inputSchema: {
    type: 'object', properties: { cloudId: { type: 'string' }, jql: { type: 'string' }, maxResults: { type: 'integer' } },
    required: ['cloudId', 'jql'], additionalProperties: false,
  } }))
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405).end(); return }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    calls.push({ method: body.method, authorization: request.headers.authorization, params: body.params })
    if (body.id === undefined) { response.writeHead(202).end(); return }
    if (body.method === 'server/discover') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id,
        error: { code: -32601, message: 'Legacy MCP fixture uses initialize' } }))
      return
    }
    const result = body.method === 'initialize' ? { protocolVersion: body.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: 'fake-jira', version: '1.0.0' } }
      : body.method === 'tools/list' ? { tools }
        : { content: [{ type: 'text', text: JSON.stringify({ issues: [{ key: 'DEMO-7' }] }) }] }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
  })
  const h = host()
  const connect = async ({ email, token }: { email: string; token: string }) => {
    const client = new Client({ name: 'test-jira-setup', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`), {
      requestInit: { headers: { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` } },
    }))
    return client
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    expect(await runSetup(args, { ...h.deps, connect })).toMatchObject({ mode: 'setup', sample: 'DEMO-7' })
    expect(calls.map(call => call.method)).toEqual(['server/discover', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
    expect(calls.every(call => call.authorization === `Basic ${Buffer.from(`operator@example.com:${token}`).toString('base64')}`)).toBe(true)
    expect(calls.at(-1)?.params).toMatchObject({ name: 'searchJiraIssuesUsingJql', arguments: { jql: 'project = "DEMO" ORDER BY updated DESC' } })
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
