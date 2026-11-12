/** The built Jira export loaded from a real Cordis entry list with only HTTP mocked. */
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'

const require = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/cordis/package.json'))
const { default: Loader } = await import(require.resolve('@deepseek-ai/cordis-plugin-loader'))
const { default: Include } = await import(require.resolve('@deepseek-ai/cordis-plugin-include'))
let context: Context | undefined
afterEach(async () => { await context?.fiber.dispose(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

it('loads the packaged Jira plugin from YAML and executes its declared read tool', async () => {
  vi.stubEnv('JIRA_COMPOSITION_EMAIL', 'operator@example.com')
  vi.stubEnv('JIRA_COMPOSITION_TOKEN', 'fixture-token')
  const issue = { id: '1', key: 'DEMO-1', fields: { summary: 'Read through the Loader' } }
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(issue)))
  vi.stubGlobal('fetch', fetcher)
  const root = new Context(); context = root
  root.baseUrl = new URL('../', import.meta.url).href
  await root.plugin(Loader)
  root.loader.builtins.include = Include
  await root.loader.create({ name: 'cordis:include', config: { path: new URL('./fixtures/jira/cordis.yml', import.meta.url).href } })
  await root.loader.await()
  const agent = {} as Agent
  Object.assign(agent, { ctx: createScope(root, agent).ctx })
  expect(root.tools.schemas(agent).map(tool => tool.name)).toHaveLength(4)
  expect(await root.tools.execute({ agent, name: 'jira_kareo_get_issue', callId: ToolCallId('jira-composition'),
    arguments: { issueIdOrKey: 'DEMO-1' }, signal: new AbortController().signal })).toMatchObject({ isError: false, value: issue })
  expect(fetcher).toHaveBeenCalledOnce()
})
