# Adapted from mycguo/tebra-superagent; MIT, see third-party/dsh-superagent/LICENSE.
"""Exercise real Git checkouts and release-pointer changes without sudo, GCP, or npm downloads."""
import fcntl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.machinery
import importlib.util
import json
import os
import shlex
from pathlib import Path
import subprocess
import sys
import tempfile
import threading

sys.dont_write_bytecode = True
loader = importlib.machinery.SourceFileLoader('gce_deploy', str(Path(__file__).parents[1] / 'deploy-gce'))
spec = importlib.util.spec_from_loader(loader.name, loader)
deploy = importlib.util.module_from_spec(spec)
loader.exec_module(deploy)


class Fixture(deploy.Host):
    def __init__(self, root):
        super().__init__()
        self.app, self.home = root / 'app', root / 'home'
        self.releases, self.control = root / 'releases', root / 'control'
        self.control.mkdir(mode=0o700)
        self.home.mkdir()
        self.running, self.events, self.idle_calls = True, [], 0
        self.busy_after_build, self.interrupt = False, False
        self.fail_stop_once = False
        self.environment = {**os.environ, 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1',
                            'GIT_AUTHOR_NAME': 'Test', 'GIT_AUTHOR_EMAIL': 'test@example.com',
                            'GIT_COMMITTER_NAME': 'Test', 'GIT_COMMITTER_EMAIL': 'test@example.com',
                            'GIT_TERMINAL_PROMPT': '0'}
        seed = root / 'seed'
        seed.mkdir()
        self.command(['git', 'init', '-b', 'main', str(seed)])
        (seed / '.gitignore').write_text('apps/cli/lib/\napps/web/dist/\nnode_modules/\n.env\n')
        (seed / 'version').write_text('old')
        self.command(['git', 'add', '.'], seed)
        self.command(['git', 'commit', '-m', 'baseline'], seed)
        for branch, marker in [('feature/good', 'good'), ('feature/bad-build', 'bad-build'), ('feature/bad-start', 'bad-start')]:
            self.command(['git', 'switch', '-c', branch], seed)
            (seed / 'version').write_text(marker)
            self.command(['git', 'commit', '-am', branch], seed)
            self.command(['git', 'switch', 'main'], seed)
        self.repo = str(root / 'origin.git')
        self.command(['git', 'clone', '--bare', str(seed), self.repo])
        self.pr_commit = self.command(['git', '--git-dir', self.repo, 'rev-parse', 'feature/good'])
        self.command(['git', '--git-dir', self.repo, 'update-ref', 'refs/pull/22/head', self.pr_commit])
        self.pr_metadata = {'number': 22, 'state': 'open', 'base': {'repo': {'full_name': deploy.REPOSITORY_NAME}},
                            'head': {'repo': {'full_name': deploy.REPOSITORY_NAME}, 'ref': 'feature/good', 'sha': self.pr_commit}}
        self.pr_auth_failure = False
        self.command(['git', 'clone', '--branch', 'main', self.repo, str(self.app)])
        self.build(self.app, 'old build')
        self.secret = self.home / 'private-secret'
        self.secret.write_text('must not be read, copied or changed')
        self.old_commit = self.git('rev-parse', 'HEAD', cwd=self.app, capture=True)

    def build(self, path, content):
        for file in ('apps/cli/lib/bin.js', 'apps/web/dist/index.html'):
            output = path / file
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(content)

    def command(self, argv, cwd=None):
        return subprocess.run(argv, cwd=cwd, env=self.environment, check=True, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.strip()

    def as_user(self, argv, cwd=None, capture=False):
        if argv[0] == str(self.home / '.local/bin/gh-agent'):
            assert argv[1:] == ['api', 'repos/' + deploy.REPOSITORY_NAME + '/pulls/22']
            if self.pr_auth_failure:
                raise deploy.DeployError('Fixture GitHub authentication failure')
            return json.dumps(self.pr_metadata)
        if argv[0] == 'pnpm':
            self.events.append('build:' + ' '.join(argv[1:]))
            if (Path(cwd) / 'version').read_text() == 'bad-build':
                raise deploy.DeployError('Fixture build failed')
            if argv[1] == 'build':
                self.build(Path(cwd), 'candidate build')
            return ''
        return self.command(argv, cwd)

    def own(self, path):
        pass

    def prepare(self, branch, job_id, report, pr_target=None):
        # Root ownership belongs to the real host. Exercise all the Git/build work with this unprivileged fixture.
        from unittest.mock import patch
        import types
        actual_stat = Path.stat
        def stat(path, *args, **kwargs):
            value = actual_stat(path, *args, **kwargs)
            if path == self.releases:
                return types.SimpleNamespace(st_uid=0, st_mode=value.st_mode)
            return value
        with patch.object(Path, 'stat', stat):
            return super().prepare(branch, job_id, report, pr_target=pr_target)

    def active(self):
        return self.running

    def health(self):
        return {'health': {'runtime': {'state': 'ready'}, 'jira': {'state': 'paused'}},
                'load': {'running': 0}, 'setup': {'problem': None}}

    def idle(self):
        self.idle_calls += 1
        if self.busy_after_build and self.idle_calls > 1:
            raise deploy.DeployError('Workers are running')
        return super().idle()

    def preflight(self):
        state, current = self.current()
        self.clean(current['path'])
        baseline = self.idle()
        return state, current, set(baseline['health'])

    def service(self, action):
        self.events.append(action)
        if action == 'stop' and self.fail_stop_once:
            self.fail_stop_once = False
            raise deploy.DeployError('Fixture stop failure')
        self.running = action == 'start'
        if action == 'start' and self.interrupt:
            raise KeyboardInterrupt('simulated host interruption')

    def wait_healthy(self, parts):
        assert parts == {'runtime', 'jira'}
        if (self.app / 'version').read_text() == 'bad-start':
            raise deploy.DeployError('Fixture startup check failed')
        return self.health()


def request(action='deploy', branch='feature/good', id='job1', pr=None):
    return {'id': id, 'action': action, 'branch': branch, 'pr': pr}


def expect_error(call, text):
    try:
        call()
    except deploy.DeployError as error:
        assert text in str(error), str(error)
    else:
        raise AssertionError('Expected deployment to fail')


def scenario(name):
    with tempfile.TemporaryDirectory(prefix='GCE deployment with spaces ') as directory:
        fixture = Fixture(Path(directory))
        if name == 'host-preflight':
            from unittest.mock import patch
            import types
            bundle = fixture.home / '.dsh/profiles/superagent/node_modules/dsh-superagent'
            bundle.parent.mkdir(parents=True)
            bundle.symlink_to('/opt/tebra-superagent')
            values = {'User': 'superagent', 'WorkingDirectory': str(fixture.app),
                      'ExecStart': '/usr/local/bin/pnpm dsh --profile superagent --host 127.0.0.1 --port 3082 --no-open',
                      'Environment': shlex.join(['DSH_HOME=' + str(fixture.home / '.dsh')])}
            fixture.execute = lambda argv, capture=False: values[argv[3].split('=', 1)[1]]
            fixture.public_health = lambda: None
            disk = types.SimpleNamespace(free=100 * 1024 ** 3)
            with patch.object(deploy.shutil, 'disk_usage', lambda path: disk):
                state, current, parts = deploy.Host.preflight(fixture)
                assert current['commit'] == fixture.old_commit and parts == {'runtime', 'jira'}
                for key, bad in [('User', 'root'), ('WorkingDirectory', '/opt/tebra-superagent'),
                                 ('ExecStart', '/usr/local/bin/dsh --profile superagent'),
                                 ('Environment', 'DSH_HOME=/tmp/new-profile')]:
                    original = values[key]
                    values[key] = bad
                    expect_error(lambda: deploy.Host.preflight(fixture), 'service')
                    values[key] = original
                bundle.unlink()
                bundle.symlink_to(fixture.app / 'third-party/dsh-superagent')
                expect_error(lambda: deploy.Host.preflight(fixture), 'existing dsh-superagent link')
                bundle.unlink()
                bundle.symlink_to('/opt/tebra-superagent')
                disk.free = 1024 ** 3
                expect_error(lambda: deploy.Host.preflight(fixture), '20 GiB')
                disk.free = 100 * 1024 ** 3
                (fixture.app / 'apps/web/dist/index.html').unlink()
                expect_error(lambda: deploy.Host.preflight(fixture), 'Build the installed Harness')
        elif name == 'missing-build':
            build = fixture.build
            def incomplete(path, content):
                build(path, content)
                (path / 'apps/web/dist/index.html').unlink()
            fixture.build = incomplete
            expect_error(lambda: deploy.rollout(fixture, request(), print), 'CLI and Web frontend')
            assert not fixture.app.is_symlink() and fixture.running
            assert 'stop' not in fixture.events and not fixture.state_file.exists()
        elif name == 'success-rollback':
            result = deploy.rollout(fixture, request(), lambda phase: None)
            assert fixture.app.is_symlink()
            assert (fixture.app / 'version').read_text() == 'good'
            assert result['current']['commit'] == fixture.git('rev-parse', 'feature/good', cwd=fixture.repo, capture=True)
            assert Path(result['previous']['path']).is_dir()
            assert result['previous']['commit'] == fixture.old_commit
            assert all(event.startswith('build:') for event in fixture.events[:3])
            assert fixture.events[3:] == ['stop', 'start']
            restored = deploy.rollout(fixture, request('rollback'), lambda phase: None)
            assert restored['current']['commit'] == fixture.old_commit
            assert (fixture.app / 'version').read_text() == 'old'
            assert fixture.secret.read_text() == 'must not be read, copied or changed'
        elif name == 'build-failure':
            expect_error(lambda: deploy.rollout(fixture, request(branch='feature/bad-build'), print), 'build failed')
            assert not fixture.app.is_symlink() and fixture.running
            assert not any(event in ('stop', 'start') for event in fixture.events)
            assert not fixture.state_file.exists()
        elif name == 'startup-rollback':
            expect_error(lambda: deploy.rollout(fixture, request(branch='feature/bad-start'), print), 'previous code restored')
            assert (fixture.app / 'version').read_text() == 'old' and fixture.running
            assert deploy.read_json(fixture.state_file)['current']['commit'] == fixture.old_commit
            assert 'pending' not in deploy.read_json(fixture.state_file)
        elif name == 'stop-failure':
            fixture.fail_stop_once = True
            expect_error(lambda: deploy.rollout(fixture, request(), print), 'previous code restored')
            assert fixture.running and not fixture.app.is_symlink()
            assert deploy.read_json(fixture.state_file)['current']['path'] == str(fixture.app)
            assert (fixture.app / 'version').read_text() == 'old'
        elif name == 'busy-after-build':
            fixture.busy_after_build = True
            expect_error(lambda: deploy.rollout(fixture, request(), print), 'Workers are running')
            assert not fixture.app.is_symlink() and fixture.running
            assert 'stop' not in fixture.events
        elif name == 'dirty-checkout':
            (fixture.app / 'version').write_text('local edit')
            expect_error(lambda: deploy.rollout(fixture, request(), print), 'local changes')
            assert fixture.events == []
            assert (fixture.app / 'version').read_text() == 'local edit'
        elif name == 'checkout-env':
            (fixture.app / '.env').write_text('PRIVATE_VALUE=keep-me')
            expect_error(lambda: deploy.rollout(fixture, request(), print), 'private systemd environment')
            assert (fixture.app / '.env').read_text() == 'PRIVATE_VALUE=keep-me'
            assert fixture.events == []
        elif name == 'interrupted-recovery':
            fixture.interrupt = True
            try:
                deploy.rollout(fixture, request(), print)
            except KeyboardInterrupt:
                pass
            else:
                raise AssertionError('Expected interruption')
            assert deploy.read_json(fixture.state_file)['pending']
            fixture.interrupt = False
            deploy.rollout(fixture, request('rollback'), print)
            assert (fixture.app / 'version').read_text() == 'old' and fixture.running
            assert 'pending' not in deploy.read_json(fixture.state_file)
        elif name == 'concurrent-lock':
            with (fixture.control / 'deploy.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                expect_error(lambda: deploy.worker(fixture, request()), 'holds the VM lock')
            assert deploy.read_json(fixture.control / 'job1.json')['status'] == 'failed'
            assert fixture.events == []
        elif name == 'private-job-state':
            deploy.worker(fixture, request())
            job = deploy.read_json(fixture.control / 'job1.json')
            assert job['status'] == 'succeeded'
            for file in [fixture.control / 'job1.json', fixture.control / 'job1.log', fixture.state_file]:
                assert file.stat().st_mode & 0o777 == 0o600
            assert fixture.secret.read_text() not in (fixture.control / 'job1.log').read_text()
        elif name == 'insecure-releases':
            fixture.releases.mkdir(mode=0o777)
            fixture.releases.chmod(0o777)
            expect_error(lambda: deploy.Host.prepare(fixture, 'feature/good', 'job1', print), 'owned by root')
            assert fixture.events == []
        elif name == 'pr-head-rollback':
            result = deploy.rollout(fixture, request(branch=None, pr=22), print)
            assert result['current']['pr'] == 22
            assert result['current']['branch'] == 'feature/good'
            assert result['current']['commit'] == fixture.pr_commit
            assert fixture.git('rev-parse', '--abbrev-ref', 'HEAD', cwd=fixture.app, capture=True) == 'HEAD'
            assert fixture.current()[1]['pr'] == 22
            assert fixture.git('rev-parse', 'HEAD', cwd=fixture.app, capture=True) == fixture.pr_commit
            restored = deploy.rollout(fixture, request('rollback'), print)
            assert restored['current']['commit'] == fixture.old_commit
            assert restored['previous']['pr'] == 22
        elif name == 'pr-moved-head':
            fixture.pr_metadata['head']['sha'] = fixture.old_commit
            expect_error(lambda: deploy.rollout(fixture, request(branch=None, pr=22), print), 'head changed during fetch')
            assert not fixture.app.is_symlink() and fixture.running
            assert fixture.events == []
        elif name == 'pr-rejected-metadata':
            for change, message in [({'state': 'closed'}, 'not open'),
                                    ({'head': {**fixture.pr_metadata['head'], 'repo': {'full_name': 'someone/fork'}}}, 'fork'),
                                    ({'head': {**fixture.pr_metadata['head'], 'repo': None}}, 'fork'),
                                    ({'head': {**fixture.pr_metadata['head'], 'sha': 'not-a-sha'}}, 'invalid PR metadata'),
                                    ({'base': {'repo': {'full_name': 'wrong/repository'}}}, 'invalid PR metadata')]:
                original = fixture.pr_metadata.copy()
                fixture.pr_metadata.update(change)
                expect_error(lambda: deploy.rollout(fixture, request(branch=None, pr=22), print), message)
                fixture.pr_metadata = original
            assert not fixture.app.is_symlink() and fixture.running and fixture.events == []
        elif name == 'pr-lookup-failure':
            fixture.pr_auth_failure = True
            expect_error(lambda: deploy.rollout(fixture, request(branch=None, pr=22), print), 'Cannot read PR #22')
            assert fixture.events == [] and fixture.running
        else:
            raise AssertionError('Unknown scenario')


def wire_health():
    token = 'a' * 43
    flags = {'unprotected': False, 'missing_source': False}
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            if self.path == '/':
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'<a href="/auth/google/start">Sign in</a>')
                return
            valid = self.headers.get('x-superagent-control') == token
            self.send_response(200 if valid or flags['unprotected'] else 401)
            self.end_headers()
            state = {'health': {'runtime': {'state': 'ready'}}, 'load': {'running': 0}}
            if not flags['missing_source']:
                state['health']['jira'] = {'state': 'paused'}
            self.wfile.write(json.dumps(state).encode())
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory() as directory:
            host = deploy.Host('http://127.0.0.1:' + str(server.server_port))
            host.home = Path(directory)
            host.loopback_url = host.public_url
            host.health_timeout = 0.05
            host.active = lambda: True
            host.as_user = lambda argv, capture=False: Path(argv[1]).read_text().strip()
            path = host.home / '.dsh/state/google-login/3082.token'
            path.parent.mkdir(parents=True)
            path.write_text(token)
            host.wait_healthy({'runtime', 'jira'})
            flags['unprotected'] = True
            expect_error(lambda: host.wait_healthy({'runtime', 'jira'}), 'Startup check failed')
            flags['unprotected'], flags['missing_source'] = False, True
            expect_error(lambda: host.wait_healthy({'runtime', 'jira'}), 'Startup check failed')
    finally:
        server.shutdown()
        server.server_close()


if sys.argv[1] == 'wire-health':
    wire_health()
else:
    scenario(sys.argv[1])
print('Scenario passed: ' + sys.argv[1])
