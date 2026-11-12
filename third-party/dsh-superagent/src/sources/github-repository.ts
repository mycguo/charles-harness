/** Repository identity and scoped adapters for a shared GitHub account and orchestration runtime. */
import { key, type ChannelRef, type Thread, type ThreadRef, type Ticket, type Trigger } from '../core/index.ts'
import { deploymentRepositories, type Deployment } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'

export function repositoryInUrl(url: string): string | undefined {
  return /^https:\/\/(?:github\.com|api\.github\.com\/repos)\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:issues|pulls?)\//i.exec(url)?.[1]
}
export const legacyRepository = (deployment: Deployment): string => deployment.legacyRepository ?? deployment.repositories?.[0] ?? deployment.repository
/** Legacy GitHub events belong to their original repository, even after the default repository changes. */
export function triggerRepository(deployment: Deployment, trigger?: Trigger): string {
  const repository = trigger?.source === 'github'
    ? typeof trigger.meta.repository === 'string' ? trigger.meta.repository : repositoryInUrl(trigger.url ?? '') ?? legacyRepository(deployment)
    : trigger?.source === 'jira' ? String(trigger.meta.repository ?? '') : deployment.repository
  const canonical = deploymentRepositories(deployment).find(name => sameName(name, repository))
  if (!canonical) throw new Error(`Repository is not watched: ${repository}`)
  return canonical
}
export function parseGithubThread(thread: string, legacy: string): { repository: string; id: string } | undefined {
  if (!thread.startsWith('github:')) return
  const value = thread.slice(7), split = value.indexOf('#')
  return split < 0 ? { repository: legacy, id: value } : { repository: value.slice(0, split), id: value.slice(split + 1) }
}
export function githubThread(repository: string, id: string, legacy: string): string {
  return `github:${sameName(repository, legacy) ? id : `${repository.toLowerCase()}#${id}`}`
}
export function repositoryForTicket(ctx: SourceContext, ticket: Ticket): string {
  return triggerRepository(ctx.deployment, ctx.triggers.get(ticket.origin.triggerId))
}

/** Adapt the existing one-repository poller without sharing cursors, numeric thread IDs, PR bindings or channels. */
export function repositoryContext(ctx: SourceContext, repository: string): SourceContext {
  const canonical = deploymentRepositories(ctx.deployment).find(name => sameName(name, repository))
  if (!canonical) throw new Error(`Repository is not watched: ${repository}`)
  const legacy = legacyRepository(ctx.deployment), isLegacy = sameName(canonical, legacy)
  const configuredRepository = Object.entries(ctx.deployment.repositoryAliases ?? {}).find(([, target]) => sameName(target, canonical))?.[0] ?? canonical
  // Preserve the original single-repository adapter and existing fixtures as well as stored event IDs.
  if (isLegacy && !ctx.deployment.repositories && ctx.deployment.repository === canonical) return ctx
  const prefix = isLegacy ? '' : `github-repo:${canonical.toLowerCase()}:`
  const scopedKey = (thread: string) => thread.startsWith('github:') ? githubThread(canonical, thread.slice(7), legacy) : thread
  const belongs = (thread: string) => {
    const parsed = parseGithubThread(thread, legacy)
    return !!parsed && sameName(parsed.repository, canonical)
  }
  const localKey = (thread: string) => { const parsed = parseGithubThread(thread, legacy); return parsed && belongs(thread) ? `github:${parsed.id}` : thread }
  const scopedRef = (ref: ThreadRef): ThreadRef => ref.source === 'github' ? { ...ref, id: scopedKey(`github:${ref.id}`).slice(7) } : ref
  const channel = (value: ChannelRef): ChannelRef => value.source === 'github'
    ? { ...value, thread: scopedKey(value.thread), address: { ...value.address, repository: canonical, configuredRepository } } : value
  const localThread = (thread: Thread): Thread => ({ ...thread, key: localKey(thread.key), ref: { ...thread.ref, id: localKey(thread.key).slice(7) } })
  const localTicket = (ticket: Ticket): Ticket => ({ ...ticket,
    ...ticket.follows ? { follows: ticket.follows.filter(follow => belongs(follow.thread)).map(follow => ({ ...follow, thread: localKey(follow.thread) })) } : {} })
  const ticketBelongs = (ticket: Ticket) => {
    if (ticket.follows?.some(follow => belongs(follow.thread))) return true
    try { return sameName(repositoryForTicket(ctx, ticket), canonical) } catch (error) { return false /* A ticket for a removed repository is outside this poller. */ }
  }
  return {
    ...ctx, deployment: { ...ctx.deployment, repository: canonical }, commands: ctx.commands.forRepository(canonical),
    state: {
      get: name => ctx.state.get(`${prefix}${name}` as typeof name),
      set: (name, value) => ctx.state.set(`${prefix}${name}` as typeof name, value),
      keys: family => ctx.state.keys({ ...family, prefix: `${prefix}${family.prefix}` } as typeof family)
        .map(name => name.slice(prefix.length) as typeof name),
    },
    receive: trigger => ctx.receive({ ...trigger, id: isLegacy ? trigger.id : key('github-repository', canonical.toLowerCase(), trigger.id),
      threads: trigger.threads.map(scopedRef), meta: { ...trigger.meta, repository: canonical, configuredRepository },
      ...trigger.meta.ci === true ? { text: trigger.text.replace(/\bRead github\//g, `Read github/repos/${canonical}/`) } : {},
      ...trigger.channel ? { channel: channel(trigger.channel) } : {} }),
    threads: {
      get: thread => { const value = ctx.threads.get(scopedKey(thread)); return value && localThread(value) },
      subscribed: source => ctx.threads.subscribed(source).filter(thread => belongs(thread.key)).map(localThread),
      patch: (thread, meta) => ctx.threads.patch(scopedKey(thread), { ...meta, repository: canonical }),
      describe: (thread, description) => ctx.threads.describe(scopedKey(thread), { ...description,
        ...description.label ? { label: `${canonical} ${description.label}` } : {},
        facts: { ...description.facts, repository: { label: 'Repository', value: canonical } } }),
    },
    tickets: {
      get: id => { const ticket = ctx.tickets.get(id); return ticket && ticketBelongs(ticket) ? localTicket(ticket) : undefined },
      open: () => ctx.tickets.open().filter(ticketBelongs).map(localTicket),
      bindThread: (id, thread, own) => ctx.tickets.bindThread(id, scopedRef(thread), own),
      threadClosed: (thread, outcome, at) => ctx.tickets.threadClosed(scopedRef(thread), outcome, at),
    },
    triggers: { get: id => ctx.triggers.get(id), latest: thread => ctx.triggers.latest(scopedKey(thread)) },
    notify: message => ctx.notify({ ...message, channel: channel(message.channel) }),
  }
}
