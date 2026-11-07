#!/usr/bin/env python3
"""Official 1.5.2 request-type probe: loopback only, synthetic account and responses."""
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
from urllib.error import HTTPError
from urllib.request import Request, urlopen


async def stop(child):
    if child and child.returncode is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            await asyncio.wait_for(child.wait(), 3)
        except asyncio.TimeoutError:
            os.killpg(child.pid, signal.SIGKILL)
            await child.wait()


async def probe(args, root):
    home, work, tmp = [root / name for name in ('home', 'work', 'tmp')]
    for directory in (home, work, tmp):
        directory.mkdir()
    if args.scenario == 'image-edit':
        import base64
        (work / 'synthetic-reference.png').write_bytes(base64.b64decode(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SBAAAAAASUVORK5CYII='))
    token_file = home / '.gemini/antigravity-cli/antigravity-oauth-token'
    token_file.parent.mkdir(parents=True)
    token_file.write_text(json.dumps({'token': {'access_token': 'synthetic-access-token',
        'refresh_token': 'synthetic-refresh-token', 'token_type': 'Bearer', 'expiry': '2099-01-01T00:00:00Z'},
        'email': 'fixture@example.invalid', 'auth_method': 'consumer'}))
    binary = Path(args.binary).resolve()
    profile = root / 'isolation.sb'
    profile.write_text(f'''(version 1)(allow default)(deny network*)
(allow network-outbound (remote ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
(allow network-bind (local ip "localhost:*"))
(deny file-write*)(allow file-write* (subpath "{root}") (literal "/dev/null"))
(deny file-read* (subpath "{Path.home().resolve()}"))
(allow file-read* (literal "{binary}"))
(deny mach-lookup (global-name "com.apple.securityd"))
(deny process-exec (literal "/usr/bin/open"))
''')
    env = {'HOME': str(home), 'TMPDIR': str(tmp), 'PATH': '/opt/homebrew/bin:/usr/bin:/bin', 'USER': 'probe',
           'LOGNAME': 'probe', 'SHELL': '/bin/sh', 'TERM': 'dumb', 'NO_COLOR': '1', 'PYTHONDONTWRITEBYTECODE': '1',
           'REQUEST_TYPES_OUT': str(root), 'REQUEST_TYPES_SCENARIO': args.scenario, 'REQUEST_TYPES_WORK': str(work)}
    version_child = await asyncio.create_subprocess_exec('/usr/bin/sandbox-exec', '-f', str(profile), str(binary),
        '--version', env=env, cwd=work, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    version_out, _ = await asyncio.wait_for(version_child.communicate(), 5)
    version = version_out.decode().strip()
    if version_child.returncode or not re.search(r'(?<!\d)1\.5\.2(?!\d)', version):
        raise RuntimeError('Official agy 1.5.2 required')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    addon = root / 'mock-proxy.py'
    shutil.copyfile(Path(__file__).with_name('official-request-types-mock-proxy.py'), addon)
    log = (root / 'proxy.log').open('wb')
    proxy = await asyncio.create_subprocess_exec('/usr/bin/sandbox-exec', '-f', str(profile), args.proxy_binary,
        '--listen-host', '127.0.0.1', '--listen-port', str(port), '--set', 'connection_strategy=lazy',
        '--set', f'confdir={root}/proxy-certs', '-q', '-s', str(addon), env=env, cwd=work,
        stdout=log, stderr=log, start_new_session=True)
    child, tasks, messages, errors, pending = None, [], [], [], {}
    sequence = 0
    try:
        cert = root / 'proxy-certs/mitmproxy-ca-cert.pem'
        for _ in range(100):
            await asyncio.sleep(.1)
            if proxy.returncode is not None:
                raise RuntimeError('Local proxy exited')
            if cert.exists():
                try:
                    _, writer = await asyncio.open_connection('127.0.0.1', port)
                    writer.close()
                    await writer.wait_closed()
                    break
                except OSError:
                    pass
        else:
            raise RuntimeError('Proxy startup timed out')
        env.update({'HTTP_PROXY': f'http://127.0.0.1:{port}', 'HTTPS_PROXY': f'http://127.0.0.1:{port}',
                    'NO_PROXY': 'localhost,127.0.0.1', 'SSL_CERT_FILE': str(cert)})
        command = ['acp', '--include-default-customizations=false', '--disable-telemetry', '--log-file', '/dev/null']
        hub_port = None
        if args.scenario == 'web-fetch':
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                hub_port = sock.getsockname()[1]
            command = ['--hub', '--hub-port', str(hub_port), '--csrf_token', 'synthetic-video-csrf',
                       '--print', 'Synthetic Hub startup fixture.', '--print-timeout', '35s',
                       '--log-file', str(root / 'official-hub.log')]
        child = await asyncio.create_subprocess_exec('/usr/bin/sandbox-exec', '-f', str(profile), str(binary), *command,
            env=env, cwd=work, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, limit=16 * 1024 * 1024, start_new_session=True)

        async def send(message):
            child.stdin.write((json.dumps(message) + '\n').encode())
            await child.stdin.drain()

        async def read_stdout():
            async for line in child.stdout:
                try:
                    message = json.loads(line)
                except ValueError:
                    errors.append(line.decode(errors='replace'))
                    continue
                messages.append(message)
                if 'method' in message and 'id' in message:
                    if message['method'] == 'session/request_permission':
                        # No external network or filesystem action is permitted by the sandbox.
                        option = next((item for item in message.get('params', {}).get('options', []) if item.get('kind') == 'allow_once'), None)
                        result = {'outcome': {'outcome': 'selected', 'optionId': option['optionId']}} if option else {'outcome': {'outcome': 'cancelled'}}
                        await send({'jsonrpc': '2.0', 'id': message['id'], 'result': result})
                    else:
                        await send({'jsonrpc': '2.0', 'id': message['id'], 'error': {'code': -32601, 'message': 'No client execution in isolated probe'}})
                elif message.get('id') in pending:
                    future = pending.pop(message['id'])
                    if not future.done():
                        future.set_result(message)

        async def read_stderr():
            async for line in child.stderr:
                errors.append(line.decode(errors='replace'))

        async def rpc(method, params):
            nonlocal sequence
            sequence += 1
            future = asyncio.get_running_loop().create_future()
            pending[sequence] = future
            await send({'jsonrpc': '2.0', 'id': sequence, 'method': method, 'params': params})
            result = await asyncio.wait_for(future, args.timeout)
            if 'error' in result:
                raise RuntimeError(f'{method}: {result["error"]}')
            return result['result']

        tasks = [asyncio.create_task(read_stdout()), asyncio.create_task(read_stderr())]
        if args.scenario == 'web-fetch':
            # main.readStdinPrompt reads a non-TTY pipe to EOF before starting Hub.
            child.stdin.close()
            await child.stdin.wait_closed()
        failure = None
        try:
            if args.scenario == 'web-fetch':
                import base64
                for _ in range(100):
                    if child.returncode is not None:
                        raise RuntimeError('Official Hub exited before startup')
                    try:
                        _, writer = await asyncio.open_connection('127.0.0.1', hub_port)
                        writer.close()
                        await writer.wait_closed()
                        break
                    except OSError:
                        await asyncio.sleep(.1)
                else:
                    # The owned synthetic process can report its Go wait stack;
                    # this distinguishes a startup prerequisite from RPC rejection.
                    child.send_signal(signal.SIGQUIT)
                    await asyncio.sleep(.3)
                    raise RuntimeError('Official Hub did not bind its local port')

                def local_call(method, payload):
                    url = f'http://127.0.0.1:{hub_port}/exa.language_server_pb.LanguageServerService/{method}'
                    request = Request(url, json.dumps(payload).encode(), headers={'content-type': 'application/json',
                        'connect-protocol-version': '1', 'x-codeium-csrf-token': 'synthetic-video-csrf'})
                    try:
                        with urlopen(request, timeout=args.timeout) as response:
                            status, data = response.status, response.read()
                    except HTTPError as error:
                        status, data = error.code, error.read()
                    result = json.loads(data)
                    messages.append({'localHubMethod': method, 'request': payload, 'status': status, 'response': result})
                    if status != 200:
                        raise RuntimeError(f'Hub {method}: HTTP {status} {result}')
                    return result

                cascade = await asyncio.to_thread(local_call, 'StartCascade',
                    {'workspaceUris': [work.as_uri()], 'requestedModel': 'MODEL_PLACEHOLDER_M320',
                     'source': 'CORTEX_TRAJECTORY_SOURCE_CLI',
                     'customAgentSpec': {'cascadeConfig': {'plannerConfig': {'planModel': 'MODEL_PLACEHOLDER_M320',
                       'declarativeMixinConfig': {'tools': [{'name': 'read_url_content', 'builtin': True}]},
                       'toolConfig': {'readUrlContent': {'forceDisable': False}}}}}})
                await asyncio.to_thread(local_call, 'SendUserCascadeMessage', {'cascadeId': cascade['cascadeId'],
                    'items': [{'text': 'Read the synthetic article at https://example.invalid/article using read_url_content.'}], 'blocking': False})
                for _ in range(int(args.timeout * 10)):
                    journal = root / 'requests.jsonl'
                    seen = [json.loads(line) for line in journal.read_text().splitlines()] if journal.exists() else []
                    if any(':fetchFromTrawlerCache' in item.get('url', '') for item in seen):
                        await asyncio.sleep(.3)
                        break
                    await asyncio.sleep(.1)
            else:
                await rpc('initialize', {'protocolVersion': 1, 'clientInfo': {'name': 'isolated-request-type-probe', 'version': '1.0'},
                    'clientCapabilities': {'fs': {'readTextFile': False, 'writeTextFile': False}, 'terminal': False}})
                session = await rpc('session/new', {'cwd': str(work), 'mcpServers': []})
                session_id = session['sessionId']
                await rpc('session/set_model', {'sessionId': session_id, 'modelId': 'gemini-3.8-flash-low'})
                await rpc('session/prompt', {'sessionId': session_id, 'prompt': [{'type': 'text',
                    'text': 'Use search_web once for the synthetic blue circle fixture, then report its result.' if args.scenario == 'web-search'
                            else 'Generate one synthetic blue circle image if your declared tools permit it.'}]})
        except Exception as error:
            failure = f'{type(error).__name__}: {error}'
        await stop(child)
        await asyncio.gather(*tasks)
        journal = root / 'requests.jsonl'
        requests = [json.loads(line) for line in journal.read_text().splitlines()] if journal.exists() else []
        types = sorted({item.get('body', {}).get('requestType') for item in requests if item.get('body', {}).get('requestType')})
        result = {'officialVersion': version, 'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
            'scenario': args.scenario, 'mockOnly': True, 'realUpstream': False, 'realAccountRead': False,
            'networkBoundary': 'Seatbelt: client and all-response proxy permit loopback only',
            'requestTypes': types, 'requestCount': len(requests), 'failure': failure,
            'requests': requests, 'acp': messages, 'stderr': ''.join(errors),
            'officialLog': (root / 'official-hub.log').read_text(errors='replace') if (root / 'official-hub.log').exists() else ''}
        serialized = json.dumps(result, ensure_ascii=False, indent=2).replace(str(root), '[TEMP_ROOT]')
        args.out.write_text(serialized + '\n')
        print(json.dumps({key: result[key] for key in ('scenario', 'requestTypes', 'requestCount', 'failure')}))
    finally:
        await stop(child)
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await stop(proxy)
        log.close()


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', default=str(Path.home() / '.local/bin/agy'))
    parser.add_argument('--proxy-binary', default='/opt/homebrew/bin/mitmdump')
    parser.add_argument('--scenario', choices=['web-search', 'image-tool', 'image-edit', 'video-summary', 'web-fetch'], default='web-search')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--timeout', type=float, default=40)
    args = parser.parse_args()
    os.umask(0o077)
    args.out = args.out.resolve()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    if args.out.exists():
        raise SystemExit('Refusing to overwrite existing probe evidence')
    with tempfile.TemporaryDirectory(prefix='agw-types-', dir='/private/tmp') as temporary:
        await probe(args, Path(temporary))


if __name__ == '__main__':
    asyncio.run(main())
