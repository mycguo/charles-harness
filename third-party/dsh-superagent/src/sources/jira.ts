/** Optional Jira Cloud Source: command polling, source context, and durable replies on the originating issue. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { family } from '../kv.ts'
import type { SourceKind } from './kind.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { pause } from './poll.ts'
import { JiraClient, JiraError } from './jira-api.ts'
import { JIRA, JIRA_MARKER, JiraConfigSchema, jiraText, jiraTrigger, type JiraConfig } from './jira-trigger.ts'

const cursor = family<{ started: string; since: string }, [site: string, project: string, repository: string]>('jira-cursor:')
const mappingMatches = (address: Record<string, unknown>, config: JiraConfig): boolean => address.site === config.site
  && config.projects.some(row => row.project === address.project && row.repository.toLowerCase() === String(address.repository).toLowerCase())
const stopped = (ctx: SourceContext, config: JiraConfig, signal?: AbortSignal): boolean => !!signal?.aborted
  || JSON.stringify(ctx.config(JIRA)) !== JSON.stringify(config)

/** No cursor advances past an unread page or a failed ingest. The Engine deduplicates repeated comment versions. */
export async function pollJira(ctx: SourceContext, signal?: AbortSignal): Promise<void> {
  const config = ctx.config<JiraConfig>(JIRA)
  if (!config) return
  const api = new JiraClient(config, signal)
  const errors: unknown[] = []
  for (const mapping of config.projects) {
    if (stopped(ctx, config, signal)) return
    const name = cursor(config.site, mapping.project, mapping.repository.toLowerCase())
    const started = new Date().toISOString()
    const state = ctx.state.get(name) ?? { started, since: started }
    // Save the initial activation boundary before any network I/O, including on a failed first poll.
    ctx.state.set(name, state)
    try {
      ctx.commands.forRepository(mapping.repository)
      // Jira search is eventually consistent. Revisit five minutes and deduplicate by comment ID/version.
      for await (const issue of api.issues(mapping.project, Date.parse(state.since) - 300_000)) {
        if (issue.fields.project.key !== mapping.project) throw new Error('Jira returned an issue outside the configured project')
        for await (const comment of api.allComments(issue.id)) {
          if (stopped(ctx, config, signal)) return
          if (Date.parse(comment.updated) < Date.parse(state.started)) continue
          const trigger = jiraTrigger(config, issue, comment)
          // Existing subscriptions fan out before Eval, so authorization must also hold at intake.
          if (!trigger || !ctx.allowsSender(trigger.actor.id)) continue
          await ctx.receive(trigger)
          ctx.threads.describe(trigger.channel!.thread, { label: `${issue.key}: ${issue.fields.summary}`, url: `${config.site}/browse/${issue.key}` })
        }
      }
      if (stopped(ctx, config, signal)) return
      ctx.state.set(name, { ...state, since: started })
    } catch (error) { if (signal?.aborted) return; errors.push(error) }
  }
  if (errors.length) {
    const retry = errors.find(error => error instanceof JiraError && error.retryMs > 0)
    throw retry ?? errors[0]
  }
}

export const jiraKind: SourceKind<JiraConfig> = {
  kind: JIRA, title: { zh: 'Jira', en: 'Jira' },
  description: { zh: '接收 Jira 评论中的 /superagent 请求，并在原问题回复。', en: 'Receives /superagent requests in Jira comments and replies on the originating issue.' },
  schema: JiraConfigSchema, health: ['jira'],
  fields: [
    { key: 'site', type: 'text', label: { zh: 'Jira Cloud 站点', en: 'Jira Cloud site' }, hint: { zh: '例如 https://example.atlassian.net', en: 'For example https://example.atlassian.net; no trailing slash.' } },
    { key: 'cloudId', type: 'text', label: { zh: 'Cloud ID', en: 'Cloud ID' }, hint: { zh: '使用带作用域的 REST API 令牌时必填。', en: 'Required for scoped REST API tokens. Requests use the Atlassian API gateway; leave empty for an unscoped token.' } },
    { key: 'email', type: 'text', label: { zh: '令牌所有者邮箱', en: 'Token owner email' } },
    { key: 'tokenEnv', type: 'text', label: { zh: '令牌环境变量名称', en: 'Token environment variable name' }, hint: { zh: '只填写变量名称，不填写令牌。', en: 'Enter the variable name, such as JIRA_SUPERAGENT_TOKEN. Store its secret value in the host environment, never here.' } },
    { key: 'projects', type: 'rows', label: { zh: '项目与仓库', en: 'Projects and repositories' },
      hint: { zh: '每个项目必须映射到此部署已配置的 GitHub 仓库。', en: 'Map each project to this deployment’s configured GitHub repository. Only new or edited command comments after activation are read.' },
      columns: [{ key: 'project', type: 'text', label: { zh: '项目键', en: 'Project key' }, pattern: '[A-Z][A-Z0-9_]*' },
        { key: 'repository', type: 'text', label: { zh: '仓库 owner/repo', en: 'Repository owner/repo' }, pattern: '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+' }] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  scope: ({ meta }, config) => mappingMatches(meta, config) ? { listened: true, observed: false, row: String(meta.project) }
    : { listened: false, reason: 'jira_project_not_allowed' },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict())
      .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate Jira account IDs').default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Jira 用户', en: 'Jira users who may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: 'Atlassian accountId', en: 'Atlassian accountId' } },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '名单内用户在评论第一个非空行写 /superagent 加请求。', en: 'A listed user starts the first nonblank line of a comment with /superagent followed by instructions. Repeat the command for follow-ups.' },
    rows: stored => JiraConfigSchema.parse(stored).projects.map(row => ({ id: row.project, label: row.project,
      note: { zh: '仅命令', en: 'Commands only' }, cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } })),
  },
  channel: {
    allowed: mappingMatches,
    async send({ commands }, message, config) {
      const address = message.channel.address
      if (!mappingMatches(address, config) || !/^\d+$/.test(address.issueId ?? '')) return 'gone'
      commands.forRepository(address.repository!)
      const api = new JiraClient(config, commands.signal)
      const issue = await api.issue(address.issueId!)
      if (issue.fields.project.key !== address.project) return 'gone'
      const me = await api.myself()
      const marker = `dsh-superagent:${message.id}`
      // A visible marker survives a lost POST response and works even when properties are unavailable.
      for await (const comment of api.allComments(issue.id)) {
        if (comment.author.accountId === me.accountId && jiraText(comment.body).split('\n').includes(marker)) return 'sent'
      }
      const body = { type: 'doc', version: 1, content: `${message.text}\n\n${marker}`.split('\n').map(text => ({ type: 'paragraph',
        content: text ? [{ type: 'text', text }] : [] })) }
      await api.request(z.unknown(), `issue/${issue.id}/comment`, { body, properties: [{ key: JIRA_MARKER, value: { id: message.id } }] })
      return 'sent'
    },
    link: address => ({ url: `${address.site}/browse/${address.issueKey}`, label: { zh: `Jira ${address.issueKey}`, en: `Jira ${address.issueKey}` } }),
  },
  threadContext: {
    messageId: trigger => String(trigger.meta.commentId),
    async read(commands, trigger, part, page, config) {
      if (!mappingMatches(trigger.meta, config)) throw new Error('Jira issue is no longer configured')
      const api = new JiraClient(config, commands.signal)
      const issue = await api.issue(String(trigger.meta.issueId))
      if (issue.fields.project.key !== trigger.meta.project) throw new Error('Jira issue moved outside the configured project')
      const body = { issue: issue.key, summary: issue.fields.summary, description: jiraText(issue.fields.description) }
      if (part !== 'thread') return { messages: [], body }
      if (page !== undefined && !/^\d+$/.test(page)) throw new Error('Invalid Jira comment cursor')
      const result = await api.comments(issue.id, Number(page ?? 0))
      const next = result.startAt + result.comments.length
      return { body, messages: result.comments.filter(comment => !comment.visibility).map(comment => ({ id: comment.id,
        from: comment.author.accountId, at: comment.updated, text: jiraText(comment.body),
        ...comment.author.accountType !== 'atlassian' || comment.properties?.some(property => property.key === JIRA_MARKER)
          || jiraText(comment.body).includes('dsh-superagent:') ? { bot: true as const } : {} })),
        ...next < result.total ? { next: String(next) } : {} }
    },
  },
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_JIRA_ISSUE', description: { zh: '发起工单的 Jira 问题键', en: 'Jira issue key that started this ticket; empty for other sources' } }],
    values: ({ trigger }) => ({ DSH_SUPERAGENT_JIRA_ISSUE: trigger?.source === JIRA ? String(trigger.meta.issueKey) : '' }),
  },
}

export async function runJira(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<JiraConfig>(JIRA)
    let delay = (config?.pollSeconds ?? 60) * 1000
    if (!ctx.configured()) ctx.report('jira', health('paused', 'setupPending'))
    else if (!config) ctx.report('jira', health('paused', 'sourceOff'))
    else if (!config.site || !config.email || !config.projects.length) ctx.report('jira', { state: 'paused', detail: 'Configure the Jira site, email and project repositories in Source settings' })
    else {
      try {
        await pollJira(ctx, signal)
        failures = 0
        if (!signal.aborted) ctx.report('jira', { state: 'ready', detail: '', at: new Date().toISOString() })
      } catch (error) {
        if (signal.aborted) return
        failures++
        ctx.report('jira', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        delay = Math.max(delay, Math.min(900_000, 30_000 * 2 ** Math.min(failures, 5)), error instanceof JiraError ? error.retryMs : 0)
      }
    }
    await pause(delay, signal)
  }
}
export const name = 'dsh-superagent-jira'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const unregister = ctx.orchestrator.sources.register(jiraKind)
    const controller = new AbortController()
    const running = runJira(sourceContext(ctx.orchestrator, jiraKind), controller.signal)
    return async () => { controller.abort(); try { await running } finally { unregister() } }
  })
}
