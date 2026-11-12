/** Jira configuration and conversion of Cloud comments into durable source Triggers. */
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'

export const JIRA = 'jira'
export const JIRA_MARKER = 'dsh-superagent'
const ProjectSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/)
export const JiraConfigSchema = z.object({
  site: z.string().trim().regex(/^(https:\/\/[a-zA-Z0-9-]+\.atlassian\.net)?$/).default(''),
  cloudId: z.string().trim().regex(/^([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})?$/).default(''),
  email: z.union([z.literal(''), z.email()]).default(''),
  tokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default('JIRA_SUPERAGENT_TOKEN'),
  projects: z.array(z.object({ project: ProjectSchema, repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) }).strict())
    .refine(rows => new Set(rows.map(row => row.project)).size === rows.length, 'Duplicate Jira projects').default([]),
  pollSeconds: z.number().int().min(60).max(3600).default(60),
}).strict()
export type JiraConfig = z.infer<typeof JiraConfigSchema>
export const JiraIssueSchema = z.looseObject({ id: z.string().regex(/^\d+$/), key: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),
  fields: z.looseObject({ summary: z.string(), description: z.unknown().optional(), project: z.looseObject({ key: ProjectSchema }) }) })
export type JiraIssue = z.infer<typeof JiraIssueSchema>
const AuthorSchema = z.looseObject({ accountId: z.string(), accountType: z.string(), displayName: z.string().optional() })
export const JiraCommentSchema = z.looseObject({ id: z.string().regex(/^\d+$/), body: z.unknown(),
  author: AuthorSchema, updateAuthor: AuthorSchema.optional(),
  created: z.string().refine(value => Number.isFinite(Date.parse(value))),
  updated: z.string().refine(value => Number.isFinite(Date.parse(value))),
  properties: z.array(z.looseObject({ key: z.string(), value: z.unknown() })).optional(),
  visibility: z.unknown().optional(),
})
export type JiraComment = z.infer<typeof JiraCommentSchema>

/** Preserve quoted/code blocks so a quoted command cannot be mistaken for an instruction. */
export function jiraText(body: unknown, depth = 0): string {
  if (depth > 30 || !body || typeof body !== 'object') return ''
  const node = body as { type?: string; text?: string; attrs?: { text?: string; url?: string }; content?: unknown[] }
  if (node.type === 'text') {
    const text = typeof node.text === 'string' ? node.text : ''
    const marks = (body as { marks?: { type?: string }[] }).marks
    return marks?.some(mark => mark.type === 'code') ? `\`${text}\`` : text
  }
  if (node.type === 'hardBreak') return '\n'
  if (node.type === 'mention') return node.attrs?.text ?? ''
  if (node.type === 'inlineCard') return node.attrs?.url ?? ''
  const children = (Array.isArray(node.content) ? node.content : []).map(child => jiraText(child, depth + 1))
  if (node.type === 'codeBlock') return `\`\`\`\n${children.join('')}\n\`\`\``
  if (node.type === 'blockquote') return children.join('\n').split('\n').map(line => `> ${line}`).join('\n')
  if (node.type === 'listItem') return `- ${children.join('\n')}`
  return children.join(node.type === 'paragraph' || node.type === 'heading' ? '' : '\n')
}
export const jiraCommand = (text: string): boolean => /^(?:[ \t]*\r?\n)*\/superagent[ \t]+\S/.test(text)
  && !text.includes('dsh-superagent:')
/** A project/repository move must not deliver new work to a worker using the old repository. */
export const jiraThreadId = (site: string, issueId: string, project: string, repository: string): string =>
  `${new URL(site).hostname}#${issueId}#${project}#${repository.toLowerCase()}`
export const jiraCommentUrl = (site: string, issue: string, comment: string): string => `${site}/browse/${issue}?focusedCommentId=${comment}`

/** Only a human's new command comment starts work; bot output and restricted comments are excluded. */
export function jiraTrigger(config: JiraConfig, issue: JiraIssue, comment: JiraComment): Trigger | undefined {
  const mapping = config.projects.find(row => row.project === issue.fields.project.key)
  const text = jiraText(comment.body)
  const actor = comment.updateAuthor ?? comment.author
  // Restricted comments must not leak into an unrestricted result comment or a GitHub PR.
  if (!mapping || actor.accountType !== 'atlassian' || comment.visibility
    || (Date.parse(comment.updated) > Date.parse(comment.created) && !comment.updateAuthor)
    || comment.properties?.some(property => property.key === JIRA_MARKER) || !jiraCommand(text)) return
  const thread = jiraThreadId(config.site, issue.id, issue.fields.project.key, mapping.repository)
  const url = jiraCommentUrl(config.site, issue.key, comment.id)
  return { id: key('jira-comment', config.site, issue.id, comment.id, comment.updated), source: JIRA,
    threads: [{ source: JIRA, id: thread }], actor: { source: JIRA, id: actor.accountId }, human: true,
    addressed: 'mention', at: new Date(comment.updated).toISOString(),
    text: `${text}\n\nJira issue ${issue.key}: ${issue.fields.summary}\n\n${jiraText(issue.fields.description)}`, url,
    channel: { source: JIRA, thread: `jira:${thread}`, address: { site: config.site, issueId: issue.id, issueKey: issue.key,
      project: issue.fields.project.key, repository: mapping.repository } },
    meta: { site: config.site, issueId: issue.id, issueKey: issue.key, project: issue.fields.project.key,
      repository: mapping.repository, commentId: comment.id, kind: 'comment' } }
}
