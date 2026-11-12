/** Jira tools through the Harness registry, including JSON schemas, failures, and plugin disposal. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import * as jira from '../src/jira-kareo.ts'

const contexts: Context[] = []
const config = { site: 'https://example.atlassian.net', cloudId: '12345678-1234-4234-8234-123456789abc',
  emailEnv: 'JIRA_TEST_EMAIL', tokenEnv: 'JIRA_TEST_TOKEN' }
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  vi.unstubAllEnvs(); vi.unstubAllGlobals()
})

async function host() {
  const root = new Context(); contexts.push(root)
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  let context!: Context
  await root.plugin({ inject: ['tools'], apply: child => { context = child } })
  const agent = {} as Agent
  Object.assign(agent, { ctx: createScope(context, agent).ctx })
  return { root, context, agent }
}

it('registers four read-only tools, snapshots their model definitions, and unregisters on disposal', async () => {
  const { context, agent } = await host()
  const plugin = context.plugin(jira, config)
  await plugin
  const schemas = context.tools.schemas(agent)
  expect(schemas.map(tool => tool.name)).toEqual(['jira_kareo_search', 'jira_kareo_get_issue', 'jira_kareo_comments', 'jira_kareo_history'])
  await expect(JSON.stringify(schemas, null, 2) + '\n').toMatchFileSnapshot('./expected/jira-tools.json')
  await plugin.dispose()
  expect(context.tools.schemas(agent)).toEqual([])
})

it('executes authenticated GET requests, renders JSON, and rejects invalid arguments before fetch', async () => {
  const { context, agent } = await host()
  vi.stubEnv(config.emailEnv, 'operator@example.com')
  vi.stubEnv(config.tokenEnv, 'private-test-token')
  const issue = { id: '1', key: 'DEMO-1', fields: { summary: 'Example' } }
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(issue)))
  vi.stubGlobal('fetch', fetcher)
  await context.plugin(jira, config)
  const call = (name: string, args: Record<string, unknown>) => context.tools.execute({ agent, name,
    callId: ToolCallId('jira-read'), arguments: args, signal: new AbortController().signal })
  const result = await call('jira_kareo_get_issue', { issueIdOrKey: 'DEMO-1' })
  expect(result).toMatchObject({ isError: false, value: issue, content: [{ type: 'text', text: JSON.stringify(issue) }] })
  const [url, options] = fetcher.mock.calls[0]!
  expect(String(url)).toContain(`/ex/jira/${config.cloudId}/rest/api/3/issue/DEMO-1`)
  expect(options?.method).toBe('GET')
  expect(new Headers(options?.headers).get('Authorization')).toBe(`Basic ${Buffer.from('operator@example.com:private-test-token').toString('base64')}`)
  expect((await call('jira_kareo_search', { jql: 'project = DEMO', maxResults: 101 })).isError).toBe(true)
  expect((await call('jira_kareo_update_issue', { issueIdOrKey: 'DEMO-1' })).isError).toBe(true)
  expect(fetcher).toHaveBeenCalledOnce()
})

it('preserves a structured sanitized tool failure when credentials are unavailable', async () => {
  const { context, agent } = await host()
  vi.stubEnv(config.emailEnv, '')
  vi.stubEnv(config.tokenEnv, '')
  await context.plugin(jira, config)
  const result = await context.tools.execute({ agent, name: 'jira_kareo_get_issue', callId: ToolCallId('jira-missing-key'),
    arguments: { issueIdOrKey: 'DEMO-1' }, signal: new AbortController().signal })
  expect(result).toMatchObject({ isError: true, error: { info: { name: 'JiraRestError', code: 'JIRA_REST_ERROR' } } })
})
