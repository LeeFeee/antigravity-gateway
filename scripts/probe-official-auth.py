#!/usr/bin/env python3
"""Capture official agy 1.5.6 auth requests against an entirely local fake upstream.

macOS only: sandbox-exec and mitmdump are required. Uses synthetic tokens/code,
fresh HOME, per-process proxy CA, no browser, no real user config or account data.
"""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import tempfile
from urllib.parse import parse_qs, urlsplit

SECRET_QUERY = {'state', 'code', 'client_secret', 'code_verifier', 'code_challenge'}


def clean_text(text):
    return re.sub(r'([?&](?:state|code|client_secret|code_verifier|code_challenge)=)[^&\s"\\]+', r'\1[REDACTED]', text)


async def stop(child):
    if child and child.returncode is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            await asyncio.wait_for(child.wait(), 3)
        except asyncio.TimeoutError:
            os.killpg(child.pid, signal.SIGKILL)
            await child.wait()


def records(out):
    journal = out / 'requests.jsonl'
    return [json.loads(line) for line in journal.read_text().splitlines()] if journal.exists() else []


async def run(scenario, root, binary, proxy_binary, timeout):
    out = root / scenario
    out.mkdir()
    home, work, tmp = [out / name for name in ('home', 'work', 'tmp')]
    for directory in (home, work, tmp):
        directory.mkdir()
    if scenario != 'login':
        token = {'token': {'access_token': 'synthetic-old-token', 'refresh_token': 'synthetic-refresh-token',
                          'token_type': 'Bearer', 'expiry': '2020-01-01T00:00:00Z' if scenario == 'refresh' else '2099-01-01T00:00:00Z'},
                 'email': 'fixture@example.invalid', 'auth_method': 'consumer'}
        # Exactly one fresh synthetic official token file. No real account data is copied.
        file = home / '.gemini/antigravity-cli/antigravity-oauth-token'
        file.parent.mkdir(parents=True)
        file.write_text(json.dumps(token))
    real_home = str(Path.home().resolve())
    profile = out / 'isolation.sb'
    profile.write_text(f'''(version 1)(allow default)(deny network*)
(allow network-outbound (remote ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
(allow network-bind (local ip "localhost:*"))
(deny file-write*)(allow file-write* (subpath "{root}") (literal "/dev/null"))
(deny file-read* (subpath "{real_home}"))
(allow file-read* (literal "{binary}"))
(deny mach-lookup (global-name "com.apple.securityd"))
(deny process-exec (literal "/usr/bin/open"))
''')
    env = {'HOME': str(home), 'TMPDIR': str(tmp), 'PATH': '/opt/homebrew/bin:/usr/bin:/bin',
           'USER': 'probe', 'LOGNAME': 'probe', 'SHELL': '/bin/sh', 'TERM': 'dumb', 'NO_COLOR': '1',
           'AUTH_PROBE_OUT': str(out), 'AUTH_PROBE_SCENARIO': scenario, 'PYTHONDONTWRITEBYTECODE': '1'}
    version_process = await asyncio.create_subprocess_exec('/usr/bin/sandbox-exec', '-f', str(profile), str(binary), '--version',
        env=env, cwd=work, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    version_stdout, _ = await asyncio.wait_for(version_process.communicate(), 5)
    version_text = version_stdout.decode().strip()
    if version_process.returncode != 0 or not re.search(r'(?<!\d)1\.5\.6(?!\d)', version_text):
        raise RuntimeError('This evidence probe requires official agy 1.5.6')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    proxy_log = (out / 'proxy.log').open('wb')
    proxy = await asyncio.create_subprocess_exec('/usr/bin/sandbox-exec', '-f', str(profile), str(proxy_binary),
        '--listen-host', '127.0.0.1', '--listen-port', str(port), '--set', 'connection_strategy=lazy',
        '--set', f'confdir={out}/proxy-certs', '-q', '-s', str(root / 'mock-proxy.py'),
        env=env, cwd=work, stdout=proxy_log, stderr=proxy_log, start_new_session=True)
    child, tasks = None, []
    stdout, stderr, auth_url = [], [], None
    try:
        cert = out / 'proxy-certs/mitmproxy-ca-cert.pem'
        for _ in range(100):
            await asyncio.sleep(.1)
            if proxy.returncode is not None:
                raise RuntimeError('Local mock proxy exited before startup')
            if cert.exists():
                try:
                    _, writer = await asyncio.open_connection('127.0.0.1', port)
                    writer.close()
                    await writer.wait_closed()
                    break
                except OSError:
                    pass
        else:
            raise RuntimeError('Local mock proxy did not start')
        env.update({'HTTP_PROXY': f'http://127.0.0.1:{port}', 'HTTPS_PROXY': f'http://127.0.0.1:{port}',
                    'NO_PROXY': 'localhost,127.0.0.1', 'SSL_CERT_FILE': str(cert)})
        command = [str(binary)]
        if scenario.startswith('onboard'):
            command += ['--print', 'Synthetic eligibility probe; no model is offered by the local mock.',
                        '--print-timeout', '8s', '--log-file', '/dev/null']
        else:
            command += ['acp', '--include-default-customizations=false', '--disable-telemetry', '--log-file', '/dev/null']
            if scenario == 'login':
                command.append('--login')
        child = await asyncio.create_subprocess_exec('/usr/bin/sandbox-exec', '-f', str(profile), *command,
            env=env, cwd=work, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, start_new_session=True)

        async def read(stream, destination):
            nonlocal auth_url
            async for line in stream:
                text = line.decode(errors='replace')
                destination.append(clean_text(text))
                if scenario == 'login' and 'https://accounts.google.com/' in text:
                    match = re.search(r'https://accounts\.google\.com/[^\s]+', text)
                    if match:
                        url = urlsplit(match.group())
                        auth_url = {'endpoint': f'{url.scheme}://{url.netloc}{url.path}',
                                    'query': {key: '[REDACTED]' if key in SECRET_QUERY else values[0] if len(values) == 1 else values
                                              for key, values in parse_qs(url.query).items()}}
                if scenario == 'refresh':
                    try:
                        message = json.loads(text)
                    except ValueError:
                        continue
                    if message.get('id') == 1:
                        child.stdin.write((json.dumps({'jsonrpc': '2.0', 'id': 2, 'method': 'session/new',
                            'params': {'cwd': str(work), 'mcpServers': []}}) + '\n').encode())
                        await child.stdin.drain()

        tasks = [asyncio.create_task(read(child.stdout, stdout)), asyncio.create_task(read(child.stderr, stderr))]
        if scenario == 'login':
            child.stdin.write(b'SYNTHETIC_AUTHORIZATION_CODE\n')
        elif scenario == 'refresh':
            child.stdin.write((json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
                'protocolVersion': 1, 'clientInfo': {'name': 'isolated-auth-probe', 'version': '1.0'}, 'clientCapabilities': {}}}) + '\n').encode())
        await child.stdin.drain()
        deadline = asyncio.get_running_loop().time() + timeout
        while child.returncode is None and asyncio.get_running_loop().time() < deadline:
            captured = records(out)
            if scenario == 'refresh' and any(item['url'].endswith(':loadCodeAssist') for item in captured):
                break
            await asyncio.sleep(.1)
        await stop(child)
        await asyncio.gather(*tasks)
        captured = records(out)
        expected = 'authorization_code' if scenario == 'login' else 'refresh_token'
        satisfied = any(item['url'].endswith(':onboardUser') for item in captured) if scenario.startswith('onboard') else any(item['body'].get('grant_type') == expected for item in captured)
        return {'scenario': scenario, 'officialVersion': '1.5.6', 'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
                'versionOutput': version_text,
                'realUpstream': False, 'realAccountRead': False, 'mockOnly': True,
                'authorizationCompletedWithGoogle': False, 'requestObserved': satisfied,
                'exitCode': child.returncode, 'authorizationUrl': auth_url, 'requests': captured,
                'stdout': clean_text(''.join(stdout)).replace(str(root), '[TEMP_ROOT]'),
                'stderr': clean_text(''.join(stderr)).replace(str(root), '[TEMP_ROOT]')}
    finally:
        await stop(child)
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await stop(proxy)
        proxy_log.close()


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', default=str(Path.home() / '.local/bin/agy'))
    parser.add_argument('--proxy-binary', default='/opt/homebrew/bin/mitmdump')
    parser.add_argument('--out', required=True)
    parser.add_argument('--timeout', type=float, default=12)
    args = parser.parse_args()
    os.umask(0o077)
    binary, proxy_binary = Path(args.binary).resolve(), Path(args.proxy_binary).resolve()
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='agw-auth-', dir='/private/tmp') as temporary:
        root = Path(temporary)
        shutil.copyfile(Path(__file__).with_name('official-auth-mock-proxy.py'), root / 'mock-proxy.py')
        summary = []
        for scenario in ('login', 'refresh', 'onboard', 'onboard-pending'):
            result = await run(scenario, root, binary, proxy_binary, args.timeout)
            (output / f'{scenario}.json').write_text(json.dumps(result, indent=2) + '\n')
            summary.append({'scenario': scenario, 'requestObserved': result['requestObserved'], 'requestCount': len(result['requests'])})
            print(json.dumps(summary[-1]), flush=True)
        (output / 'summary.json').write_text(json.dumps({'mockOnly': True, 'realGoogleAuthorization': False, 'scenarios': summary}, indent=2) + '\n')
        if not all(item['requestObserved'] for item in summary):
            raise SystemExit('One or more official request branches were not observed')


if __name__ == '__main__':
    asyncio.run(main())
