/** Recorded-session adapter for the production Superagent resource tool and repository selector. */
import { z } from 'zod'
import { Commands } from '../../../third-party/dsh-superagent/src/infra/commands.ts'
import { TextCache } from '../../../third-party/dsh-superagent/src/app/cache.ts'
import { mainTools } from '../../../third-party/dsh-superagent/src/app/tools/main.ts'

export const name = 'superagent-repository-fixture'
export const inject = ['tools']

/**
 * Register the production read tool with deterministic GitHub CLI responses.
 * @param ctx - Cordis context owning the tool and CLI interception.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const original = Commands.prototype.run
    Commands.prototype.run = async function (program, args, cwd) {
      if (program !== '/snapshot/github') return original.call(this, program, args, cwd)
      const match = /^repos\/(acme\/widgets|other\/tools)\/issues\/42$/.exec(args[1] ?? '')
      if (!match) throw new Error('Unexpected repository fixture request')
      return JSON.stringify({ id: 42, number: 42, title: `Issue in ${match[1]}`, state: 'open',
        body: `Work for ${match[1]}`, user: { login: 'alice' }, created_at: '2026-11-01T00:00:00Z',
        html_url: `https://github.com/${match[1]}/issues/42` })
    }
    return () => { Commands.prototype.run = original }
  })
  const deployment = { repository: 'acme/widgets', repositories: ['acme/widgets', 'other/tools'],
    github: { cli: '/snapshot/github' } }
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const tool = mainTools({ resources: { commands, masterId: 'repository-snapshot', pages: new TextCache(100000) } }, {})
    .find(value => value.name === 'orchestrator_read')
  ctx.effect(() => ctx.tools.register({ name: tool.name, description: tool.description,
    parameters: JSON.parse(JSON.stringify(z.toJSONSchema(tool.schema))),
    output: { schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: (args, execution) => tool.execute(tool.schema.parse(args), execution.signal) }))
}
