/** Adapted from mycguo/tebra-superagent; MIT, see third-party/dsh-superagent/LICENSE. */
/** Branch rollout failures, code rollback and private health checks without touching a real VM. */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it as test } from 'vitest'

// Deployment requires POSIX fcntl, executable fixtures and systemd on the Linux VM.
const it = test.skipIf(process.platform === 'win32')

const script = join(import.meta.dirname, 'deploy-gce')
const fixture = join(import.meta.dirname, 'fixtures', 'gce-deploy.py')
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function python(args: string[], env = process.env): Promise<{ code: number; output: string; killed: boolean; signal: string | null }> {
  return new Promise(resolve => execFile('python3', args, { env, timeout: 20_000 }, (error, stdout, stderr) => {
    resolve({ code: typeof error?.code === 'number' ? error.code : error ? 1 : 0, output: stdout + stderr, killed: error?.killed ?? false, signal: error?.signal ?? null })
  }))
}
for (const name of ['host-preflight', 'missing-build', 'success-rollback', 'build-failure', 'startup-rollback', 'stop-failure', 'busy-after-build', 'dirty-checkout',
  'checkout-env', 'interrupted-recovery', 'concurrent-lock', 'private-job-state', 'insecure-releases', 'wire-health']) {
  it(`verifies ${name}`, async () => {
    const result = await python([fixture, name])
    expect(result, result.output).toMatchObject({ code: 0, killed: false, signal: null })
    expect(result.output).toContain('Scenario passed')
  })
}
for (const name of ['pr-head-rollback', 'pr-moved-head', 'pr-rejected-metadata', 'pr-lookup-failure']) {
  it(`verifies ${name}`, async () => {
    const result = await python([fixture, name])
    expect(result, result.output).toMatchObject({ code: 0, killed: false, signal: null })
    expect(result.output).toContain('Scenario passed')
  })
}
// Each CLI invocation gets its own timeout: cumulative Python startup time on
// the small deployment VM must not consume one shared five-second test budget.
it.each(['--upload-pack=bad', 'foo;touch /tmp/never', 'feature/../main', 'HEAD~1', 'https://github.com/x/y', 'feature/.hidden', 'name.lock'])(
  'rejects invalid branch %s before contacting gcloud', async (branch) => {
    expect(await python([script, '--branch', branch])).toMatchObject({ code: 2, killed: false, signal: null })
  },
)
it.each(['0', '-1', 'abc', '22;touch', 'https://github.com/mycguo/charles-harness/pull/22'])(
  'rejects invalid PR number %s before contacting gcloud', async (value) => {
    expect(await python([script, '--pr', value])).toMatchObject({ code: 2, killed: false, signal: null })
  },
)
it.each([
  ['insecure origin', ['--branch', 'main', '--url', 'http://example.com']],
  ['redundant status dry run', ['--status', '--dry-run']],
  ['PR and branch together', ['--pr', '22', '--branch', 'main']],
  ['PR and rollback together', ['--pr', '22', '--rollback']],
] as const)('rejects %s before contacting gcloud', async (_name, args) => {
  expect(await python([script, ...args])).toMatchObject({ code: 2, killed: false, signal: null })
})
it('forwards PR selection and dry-run to the VM without requiring a local GitHub CLI', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gce PR caller ')); directories.push(root)
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin/gh'), '#!/bin/sh\nexit 99\n', { mode: 0o755 })
  writeFileSync(join(root, 'bin/gcloud'), `#!/usr/bin/env python3
import json,sys
from pathlib import Path
Path(${JSON.stringify(join(root, 'request.json'))}).write_text(json.dumps({'args':sys.argv[1:],'input':sys.stdin.read()}))
`, { mode: 0o755 })
  expect(await python([script, '--pr', '22', '--dry-run'], {
    ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`,
  })).toMatchObject({ code: 0, killed: false, signal: null })
  const request = JSON.parse(readFileSync(join(root, 'request.json'), 'utf8')) as { args: string[] }
  const command = request.args.find(arg => arg.startsWith('--command='))!
  expect(command).toContain('"action": "deploy"')
  expect(command).toContain('"pr": 22')
  expect(command).toContain('"branch": null')
  expect(command).toContain('"dry_run": true')
})
it('uses existing gcloud authentication and IAP with a quoted branch and ships only the tool source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gce caller ')); directories.push(root)
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin/gcloud'), `#!/usr/bin/env python3
import json,sys
from pathlib import Path
Path(${JSON.stringify(join(root, 'request.json'))}).write_text(json.dumps({'args':sys.argv[1:],'input':sys.stdin.read()}))
print('mock read-only preflight')
`, { mode: 0o755 })
  const secret = 'test-key-never-transferred'
  const result = await python([script, '--branch', 'codex/test-me', '--dry-run'], {
    ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, OPENAI_API_KEY: secret,
  })
  expect(result).toMatchObject({ code: 0, killed: false, signal: null })
  const request = JSON.parse(readFileSync(join(root, 'request.json'), 'utf8')) as { args: string[]; input: string }
  expect(request.args).toEqual(expect.arrayContaining(['compute', 'ssh', 'superagent', '--tunnel-through-iap', '--ssh-flag=-T']))
  expect(request.args.find(arg => arg.startsWith('--command='))).toContain('sudo -n /usr/bin/python3 - --_remote')
  expect(request.args.find(arg => arg.startsWith('--command='))).toContain('codex/test-me')
  expect(request.input).toContain('RUNNER_SOURCE = ')
  expect(JSON.stringify(request) + result.output).not.toContain(secret)
})

it('starts the source profile while retaining the existing service settings', () => {
  const override = readFileSync(join(import.meta.dirname, '../deploy/google-cloud/charles-runtime.conf'), 'utf8')
  expect(override).toContain('WorkingDirectory=/opt/charles-harness')
  expect(override).toContain('ExecStart=\nExecStart=/usr/local/bin/pnpm dsh --profile superagent --host 127.0.0.1 --port 3082 --no-open')
  expect(override).not.toMatch(/^(?:User|Group|Environment|EnvironmentFile)=/m)
})
