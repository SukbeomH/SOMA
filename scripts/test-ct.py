#!/usr/bin/env python3
"""Exercise deployment boundaries with fake OS/tools; installs nothing, uses no network."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

SCRIPT = Path(__file__).with_name('ct.sh').resolve()
subprocess.run(['bash', '-n', str(SCRIPT)], check=True)
assert subprocess.run(['bash', str(SCRIPT), 'help'], capture_output=True).returncode == 0
assert subprocess.run(['bash', str(SCRIPT), 'invalid'], capture_output=True).returncode != 0
if not Path('/etc/os-release').exists():
    raise SystemExit('Run the mocked deployment tests on Linux (no target CT required)')
if os.geteuid() == 0:
    raise SystemExit('Run these isolated tests as a non-root user')
with tempfile.TemporaryDirectory(prefix='soma-ct-test-') as tmp:
    home = Path(tmp).resolve()
    root = home / 'SOMA'
    (root / 'scripts').mkdir(parents=True)
    script = root / 'scripts/ct.sh'
    shutil.copyfile(SCRIPT, script)
    state = root / '.ct-runtime'
    state.mkdir()
    (root / 'app/dist/web').mkdir(parents=True)
    (root / 'app/dist/web/server.js').touch()
    (root / 'app/package-lock.json').write_text('{}')
    (root / 'python').mkdir()
    (root / 'python/requirements-web.txt').touch()
    node_dir = home / '.local/share/soma-node/v24.22.2'
    node_dir.mkdir(parents=True)
    (root / '.venv/bin').mkdir(parents=True)
    python = root / '.venv/bin/python'
    python.write_text('#!/bin/sh\nexit 0\n')
    python.chmod(0o700)
    mocks = home / 'mocks.sh'
    mocks.write_text(r'''
function . { ID=ubuntu; VERSION_ID=${TEST_OS:-24.04}; }
uname() { if [[ $1 == -s ]]; then echo Linux; else echo x86_64; fi; }
systemd-detect-virt() { echo "${TEST_VIRT:-lxc}"; }
awk() { if [[ ${*: -1} == /proc/self/uid_map ]]; then [[ ${TEST_PRIVILEGED:-0} == 0 ]]; else command awk "$@"; fi; }
getent() { printf 'test:x:1000:1000::%s:/bin/bash\n' "$HOME"; }
git() { if [[ $1 == --exec-path ]]; then echo /usr/lib/git-core; else echo fake-sha; fi; }
ss() { [[ -z ${TEST_LISTENER:-} ]] || printf '%s\n' "$TEST_LISTENER"; return 0; }
node() { echo v24.22.2; }
npm() { echo "$*" >> "$HOME/npm-calls"; [[ ${TEST_NPM_FAIL:-0} == 0 ]]; }
codex() { echo codex-cli-0.167.0; }
curl() { [[ ${TEST_HTTP:-0} == 1 ]] || { echo 'Network not allowed in tests' >&2; return 99; }; }
''')
    env = {**os.environ, 'HOME': str(home), 'BASH_ENV': str(mocks)}
    for key in ['SOMA_CT_PORT', 'SOMA_CT_LAN_HOST', 'SOMA_CT_TAILSCALE_HOST', 'SOMA_WEB_LAN_HOST', 'SOMA_WEB_TAILSCALE_HOST']:
        env.pop(key, None)
    def run(command, ok=True, contains='', **extra):
        result = subprocess.run(['bash', str(script), *command.split()], env={**env, **extra}, text=True, capture_output=True)
        assert (result.returncode == 0) == ok, (command, result.stdout, result.stderr)
        assert contains in result.stdout + result.stderr, (command, result.stdout, result.stderr)
        return result.stdout

    run('prepare', False, 'CT root')
    run('install', False, 'Ubuntu 24.04', TEST_OS='22.04')
    run('install', False, 'Requires an LXC', TEST_VIRT='docker')
    run('install', False, 'Root UID is not remapped', TEST_PRIVILEGED='1')
    run('install --bad', False, 'Only install')
    run('install', False, 'Invalid SOMA_CT_PORT', SOMA_CT_PORT='80')
    for invalid in ['999.1.2.3', '192.168.01.2', 'lan.example']:
        run('install', False, 'Invalid SOMA_CT_LAN_HOST', SOMA_CT_LAN_HOST=invalid)
        assert not (state / 'ready').exists()
    run('run', False, 'No successful install')
    run('install', False, 'already listening', TEST_LISTENER='LISTEN 0 10 127.0.0.1:8765 0.0.0.0:*')
    (state / 'ready').touch()
    run('install', False, 'Installation failed', TEST_NPM_FAIL='1')
    assert not (state / 'ready').exists(), 'failed install retained success marker'
    assert not (state / 'install.lock').exists(), 'failure left lock'
    run('install', True, 'Installed.', SOMA_CT_PORT='8876')
    assert (state / 'ready').exists()
    assert (state / 'port').read_text().strip() == '8876'
    calls = (home / 'npm-calls').read_text()
    for expected in ['ci --ignore-scripts', 'rebuild node-pty', 'run build:web', 'run test:headless']:
        assert expected in calls
    run('install', True, 'Installed.')
    assert (state / 'port').read_text().strip() == '8876', 'reinstall lost saved port'
    unit = run('unit')
    assert 'Environment=SOMA_CONTAINER=0' in unit
    assert 'Environment=SOMA_WEB_PORT=8876' in unit
    assert 'Restart=no' in unit and 'User=root' not in unit
    run('status', False, 'No listening')
    run('status', False, 'Unexpected listener', TEST_LISTENER='LISTEN 0 10 0.0.0.0:8876 0.0.0.0:*')
    run('status', True, 'HTTP OK', TEST_HTTP='1', TEST_LISTENER='LISTEN 0 10 127.0.0.1:8876 0.0.0.0:*')
    run('install', True, 'Installed.', SOMA_CT_LAN_HOST='192.168.1.20', SOMA_CT_TAILSCALE_HOST='soma.tail0.ts.net')
    run('install', True, 'Installed.')
    unit = run('unit')
    assert 'Environment=SOMA_WEB_LAN_HOST=192.168.1.20' in unit
    assert 'Environment=SOMA_WEB_TAILSCALE_HOST=soma.tail0.ts.net' in unit
    run('status', True, 'LAN access enabled', TEST_HTTP='1', TEST_LISTENER='LISTEN 0 10 0.0.0.0:8876 0.0.0.0:*')
    run('install', True, 'Installed.', SOMA_CT_LAN_HOST='', SOMA_CT_TAILSCALE_HOST='')
    assert not (state / 'lan_host').exists() and not (state / 'ts_host').exists()
    assert 'Environment=SOMA_WEB_LAN_HOST=' not in run('unit')
    run('status', False, 'Unexpected listener', TEST_LISTENER='LISTEN 0 10 0.0.0.0:8876 0.0.0.0:*')
    (state / 'install.lock').mkdir()
    run('install', False, 'Install lock exists')
print('PASS: CT guards, install failure/readiness, saved port, build/test calls, unit and listener checks (mock tools only)')
