import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
const script = resolve('scripts/prepare-github-ticket')
const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

// The packaged checkout helper uses POSIX advisory file locks.
it.skipIf(process.platform === 'win32')('checks out equal PR numbers from separate repository caches and refuses to reuse another repository checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prepare-repositories-')); directories.push(root)
  const config = join(root, 'gitconfig')
  await writeFile(config, `[user]\n  name = Test\n  email = test@example.com\n[url "file://${root}/remote/"]\n  insteadOf = https://github.com/\n[protocol "file"]\n  allow = always\n`)
  const env = gitEnv({ GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' })
  const git = async (...args: string[]) => (await exec('git', args, { env })).stdout.trim()
  for (const [index, repository] of ['acme/widgets', 'other/tools'].entries()) {
    const work = join(root, `source-${index}`), remote = join(root, 'remote', `${repository}.git`)
    await mkdir(dirname(remote), { recursive: true })
    await git('init', '--bare', '--quiet', remote)
    await git('init', '--quiet', work)
    await writeFile(join(work, 'repository.txt'), repository)
    await git('-C', work, 'add', '.')
    await git('-C', work, 'commit', '--quiet', '-m', 'Source content')
    await git('-C', work, 'push', '--quiet', remote, 'HEAD:refs/pull/42/head')
  }
  const prepare = (repository: string, directory: string, ticket: string) => exec('python3', [script], { env: { ...env,
    DSH_SUPERAGENT_GITHUB_REPOSITORY: repository, DSH_SUPERAGENT_GITHUB_PR_HEAD: 'refs/pull/42/head',
    DSH_SUPERAGENT_TICKET: ticket, DSH_SUPERAGENT_DIR: directory, DSH_SUPERAGENT_REPOSITORY_CACHE: join(root, 'cache') } })
  const first = join(root, 'ticket-a'), second = join(root, 'ticket-b')
  await Promise.all([prepare('acme/widgets', first, 'ticket-a'), prepare('other/tools', second, 'ticket-b'),
    prepare('acme/widgets', join(root, 'ticket-c'), 'ticket-c')])
  expect(await readFile(join(first, 'repository.txt'), 'utf8')).toBe('acme/widgets')
  expect(await readFile(join(second, 'repository.txt'), 'utf8')).toBe('other/tools')
  expect(await git('-C', first, 'rev-parse', '--git-common-dir')).not.toBe(await git('-C', second, 'rev-parse', '--git-common-dir'))
  await expect(prepare('acme/widgets', first, 'ticket-a')).resolves.toMatchObject({ stdout: expect.stringContaining('existing checkout') })
  await expect(prepare('other/tools', first, 'ticket-b')).rejects.toMatchObject({ stderr: expect.stringContaining('another repository cache') })
  await expect(prepare('../tools', join(root, 'invalid'), 'ticket-c')).rejects.toMatchObject({ stderr: expect.stringContaining('owner/repo') })
  expect(await readFile(join(first, 'repository.txt'), 'utf8')).toBe('acme/widgets')
}, 30_000)
