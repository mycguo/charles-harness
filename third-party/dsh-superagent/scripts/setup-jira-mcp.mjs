#!/usr/bin/env node
/** Configure the host's existing MCP client after a read-only Jira capability and access check. */
import { readFile, lstat, open, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, parseEnv } from 'node:util'
import { randomUUID } from 'node:crypto'
import { isMap, isSeq, parseDocument } from 'yaml'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

export const ENDPOINT = 'https://mcp.atlassian.com/v2/mcp?tools=all'
export const REQUIRED_TOOLS = ['searchJiraIssuesUsingJql', 'getJiraIssue', 'listJiraIssueComments', 'listJiraIssueChangelogs']
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE = '@deepseek-ai/dsh-mcp-client'
const HELP = `Usage: ./scripts/setup-jira-mcp.mjs --email operator@example.com --site https://example.atlassian.net --project DEMO

Options:
  --email EMAIL       Atlassian account that owns the API token
  --site URL          Jira Cloud site, without a path
  --project KEY       Project used for the read-only JQL access test
  --server-name NAME  MCP namespace (default: jira); use a unique name for each account
  --token-env NAME    Token variable (default for jira: JIRA_MYCGUO_TOKEN)
  --profile NAME     Existing DSH profile (default: DSH_SUPERAGENT_PROFILE or superagent)
  --probe            Test credentials and Jira capabilities without changing a profile
  --check            Check the saved profile and test Jira access without changing it
  --help             Show this help

Reads the token from the launching environment, this checkout's .env, or DSH_HOME/.env,
in that order, matching the launcher. No token is accepted in command arguments.
Setup backs up the profile and adds the native DSH MCP client. Restart afterward.
Named connections require an explicit --token-env and preserve other Jira accounts.
Requires a host with @deepseek-ai/dsh-mcp-client (included in DSH 0.2.1-rc.3).
`

class SetupError extends Error {}
const fail = message => { throw new SetupError(message) }

async function dotenv(path) {
  try { return parseEnv(await readFile(path, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return {}
    fail('Cannot read an environment file; check its path and permissions.')
  }
}

export function headerExpression(email, variable) {
  return `(() => { const token = process.env[${JSON.stringify(variable)}]?.trim(); if (!token) throw new Error("Jira MCP token is missing from the host environment"); return "Basic " + Buffer.from(${JSON.stringify(email + ':')} + token).toString("base64"); })()`
}

async function connect({ email, token }) {
  const client = new Client({ name: 'dsh-superagent-jira-setup', version: '1.0.0' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } })
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    requestInit: { headers: { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` } },
  })
  try {
    await client.connect(transport, { timeout: 20_000 })
    return client
  } catch (error) { await client.close().catch(() => {}); throw error }
}

export async function probeJira(client, site, project) {
  const tools = []
  const cursors = new Set()
  let cursor
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { cacheMode: 'refresh', timeout: 20_000 })
    tools.push(...page.tools)
    cursor = page.nextCursor
    if (cursor && (cursors.has(cursor) || cursors.size >= 100)) fail('Jira MCP returned an invalid tool-list cursor.')
    cursors.add(cursor)
  } while (cursor)
  const names = new Set(tools.map(tool => tool.name))
  if (REQUIRED_TOOLS.some(name => !names.has(name))) {
    fail('Jira read/search tools are missing. Create an Atlassian MCP V2 token with read:jira:agent-interface and search:jira:agent-interface; allow Jira Read and Search in the organization MCP permissions. Rovo search alone is insufficient.')
  }
  if (tools.some(tool => /^(?:create|edit|update|delete|transition|add|upload|manage|watch|link|unlink|assign|remove|set|vote).*Jira/i.test(tool.name))) {
    fail('This token advertises Jira mutation tools. Use a token limited to Jira read and search scopes, then retry.')
  }
  const tool = tools.find(tool => tool.name === 'searchJiraIssuesUsingJql')
  const args = { cloudId: site, jql: `project = "${project}" ORDER BY updated DESC` }
  if (tool.inputSchema?.properties?.maxResults) args.maxResults = 1
  const result = await client.callTool({ name: tool.name, arguments: args }, { toolDefinition: tool, timeout: 20_000 })
  if (result.isError) fail('Jira JQL access test failed. Check the site, project, token scopes and account permissions.')
  // Print only an issue key as evidence, never response bodies, user data or credentials.
  const sample = JSON.stringify(result).match(new RegExp(`\\b${project}-[0-9]+\\b`))?.[0]
  return { tools: REQUIRED_TOOLS, sample }
}

function entries(sequence) {
  return sequence.items.flatMap(row => {
    if (!isMap(row)) return []
    const inserted = row.get('insert', true)
    return [row, ...(isSeq(inserted) ? entries(inserted) : [])]
  })
}

/** deps is used by offline tests; the CLI always connects to the fixed official Atlassian endpoint. */
export async function runSetup(args, deps = {}) {
  try {
    const environment = deps.environment ?? process.env
    const { values } = parseArgs({ args, options: {
      email: { type: 'string' }, site: { type: 'string' }, project: { type: 'string' },
      'server-name': { type: 'string', default: 'jira' }, 'token-env': { type: 'string' },
      profile: { type: 'string', default: environment.DSH_SUPERAGENT_PROFILE || 'superagent' },
      probe: { type: 'boolean' }, check: { type: 'boolean' }, help: { type: 'boolean' },
    } })
    if (values.help) return { help: HELP }
    if (values.probe && values.check) fail('Choose either --probe or --check.')
    const email = values.email?.trim()
    if (!email || !/^[^\s@:\r\n]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Supply --email with the Atlassian account email.')
    if (!values.site) fail('Supply --site with your Jira Cloud origin.')
    const site = new URL(values.site)
    if (site.protocol !== 'https:' || !/^[a-z0-9-]+\.atlassian\.net$/.test(site.hostname) || site.port
      || site.username || site.password || site.pathname !== '/' || site.search || site.hash) fail('--site must be an HTTPS *.atlassian.net origin without a path or credentials.')
    const project = values.project
    if (!project || !/^[A-Z][A-Z0-9_]*$/.test(project)) fail('Supply --project with an uppercase Jira project key.')
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(values.profile)) fail('Invalid DSH profile name.')
    const serverName = values['server-name']
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) fail('--server-name must contain 1–32 letters, numbers, underscores or hyphens.')
    const id = `mcp-${serverName}`
    if (serverName !== 'jira' && !values['token-env']) fail('Supply --token-env for a named Jira connection so its account credential is explicit.')
    const variable = values['token-env'] ?? 'JIRA_MYCGUO_TOKEN'
    if (!/^JIRA_[A-Z0-9_]+$/.test(variable)) fail('--token-env must be a JIRA_ environment variable name.')
    const home = resolve(environment.DSH_HOME || join(homedir(), '.dsh'))
    const env = { ...await dotenv(join(home, '.env')), ...await dotenv(deps.dotenvPath ?? join(ROOT, '.env')), ...environment }
    const token = env[variable]?.trim()
    if (!token || /[\r\n]/.test(token)) fail('Jira token is missing or invalid. Set the selected token variable in the launching environment or checkout .env.')
    const patch = join(home, 'profiles', values.profile, 'cordis.patch.yml')
    let original, document, row
    const expression = headerExpression(email, variable)
    if (!values.probe) {
      if (!(await lstat(patch)).isFile()) fail('The existing profile patch must be a regular file.')
      original = await readFile(patch, 'utf8')
      document = parseDocument(original, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] })
      if (document.errors.length || document.warnings.length || !isSeq(document.contents)) fail('The profile patch must be a valid YAML entry list; nothing was changed.')
      const all = entries(document.contents)
      if (all.some(entry => entry.get('id') !== id && entry.get('disabled') !== true && entry.getIn(['config', 'serverName']) === serverName)) {
        fail(`The ${serverName} MCP server name is already used by another entry; nothing was changed.`)
      }
      const matches = all.filter(entry => entry.get('id') === id)
      if (matches.some(entry => entry.has('name') && entry.get('name') !== PACKAGE)) fail(`The ${id} entry belongs to another plugin; nothing was changed.`)
      if (matches.some(entry => entry.getIn(['config', 'serverName']) !== undefined && entry.getIn(['config', 'serverName']) !== serverName)) {
        fail(`The ${id} entry belongs to another server namespace; nothing was changed.`)
      }
      row = matches.at(-1)
      if (row?.has('config') && !isMap(row.get('config', true))) fail('Existing Jira MCP config must be a YAML mapping; nothing was changed.')
      if (values.check && (!row || row.get('disabled') === true
        || row.getIn(['config', 'url']) !== ENDPOINT || row.getIn(['config', 'serverName']) !== serverName
        || row.getIn(['config', 'transport']) !== 'streamable-http'
        || row.getIn(['config', 'headers', 'Authorization']) !== expression
        || row.getIn(['config', 'headers', 'Authorization'], true)?.tag !== 'tag:yaml.org,2002:js')) {
        fail('This profile has no matching active Jira MCP configuration. Run setup without --check first.')
      }
    }
    let client, evidence
    try {
      client = await (deps.connect ?? connect)({ email, token })
      evidence = await probeJira(client, site.origin, project)
    } finally { await client?.close().catch(() => {}) }
    if (values.probe || values.check) return { mode: values.probe ? 'probe' : 'check', serverName, entryId: id, site: site.origin, project, ...evidence }
    if (!row) {
      const inserted = document.createNode({ insert: [{ id, name: PACKAGE }] })
      document.contents.add(inserted)
      row = inserted.get('insert', true).items[0]
    }
    row.set('disabled', false)
    if (!row.has('config')) row.set('config', document.createNode({}))
    const config = row.get('config', true)
    config.set('serverName', serverName)
    config.set('transport', 'streamable-http')
    config.set('url', ENDPOINT)
    // Replace authentication as a unit; preserve unrelated reconnect/timeout preferences.
    config.set('headers', document.createNode({ Authorization: expression }))
    if (!config.has('toolCallTimeoutMs')) config.set('toolCallTimeoutMs', 60_000)
    config.set('failOnStartupError', false)
    row.getIn(['config', 'headers', 'Authorization'], true).tag = 'tag:yaml.org,2002:js'
    const updated = document.toString()
    const lock = `${patch}.jira-mcp.lock`
    const handle = await open(lock, 'wx', 0o600)
    const temporary = `${patch}.${randomUUID()}.tmp`
    let backup
    try {
      if (await readFile(patch, 'utf8') !== original) fail('Profile changed during setup; retry the command.')
      if (updated !== original) {
        backup = `${patch}.backup-${randomUUID()}`
        const saved = await open(backup, 'wx', 0o600)
        try { await saved.writeFile(original) } finally { await saved.close() }
        const pending = await open(temporary, 'wx', 0o600)
        try { await pending.writeFile(updated) } finally { await pending.close() }
        await rename(temporary, patch)
      }
    } finally { await unlink(temporary).catch(() => {}); await handle.close(); await unlink(lock) }
    return { mode: 'setup', changed: updated !== original, profile: values.profile, serverName, entryId: id, backup, site: site.origin, project, ...evidence }
  } catch (error) {
    if (error instanceof SetupError) throw error
    // Never surface SDK, URL-parser, dotenv or filesystem messages that might contain supplied secrets.
    throw new SetupError('Jira MCP setup/check failed. Check connectivity, account email, token, profile path and file permissions. No upstream error body was printed.')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSetup(process.argv.slice(2)).then(result => {
    if (result.help) { process.stdout.write(result.help); return }
    console.log(`Jira MCP ${result.mode} succeeded: ${result.serverName}, ${result.site}, project ${result.project}.`)
    console.log(`Verified tools: ${result.tools.join(', ')}`)
    console.log(result.sample ? `JQL returned ${result.sample}.` : 'JQL succeeded; no sample issue key was returned.')
    if (result.mode === 'setup') {
      console.log(result.changed ? `Profile updated; backup: ${result.backup}` : 'Profile already configured; no changes made.')
      console.log('Restart the existing DSH profile with the same DSH_HOME and the selected token variable, following the Jira setup guide.')
    } else if (result.mode === 'check') console.log('Profile and upstream access verified. This does not prove that the running host has loaded the profile; confirm a tool call in its Trajectory view.')
  }).catch(error => { console.error(error.message); process.exitCode = 1 })
}
