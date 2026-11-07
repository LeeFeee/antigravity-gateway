"""Synthetic, all-response upstream for probe-official-request-types.py.

Every request receives a local response. Seatbelt additionally denies external
network access; this addon must never be used as a forwarding proxy.
"""
import base64
import asyncio
import json
import os
from pathlib import Path
import re
from urllib.parse import parse_qs, urlsplit

from mitmproxy import http

OUT = Path(os.environ['REQUEST_TYPES_OUT'])
SCENARIO = os.environ['REQUEST_TYPES_SCENARIO']
SECRET = re.compile(r'^(authorization|cookie|set-cookie|client_secret|access_token|refresh_token|id_token|code_verifier|code|state|code_challenge)$', re.I)
AGENT_CALLS = 0
WEB_FETCH_SENT = False


def clean(value):
    if isinstance(value, dict):
        return {key: '[REDACTED]' if SECRET.match(key) else clean(item) for key, item in value.items()}
    if isinstance(value, list):
        return [clean(item) for item in value]
    if isinstance(value, str):
        return value.replace(str(OUT), '[TEMP_ROOT]')
    return value


def model(name, enum, **extra):
    return {'displayName': name, 'model': enum, 'apiProvider': 'API_PROVIDER_GOOGLE_GEMINI',
            'modelProvider': 'MODEL_PROVIDER_GOOGLE', 'maxTokens': 1048576, 'maxOutputTokens': 65536,
            'quotaInfo': {'remainingFraction': 1, 'resetTime': '2099-01-01T00:00:00Z'}, **extra}


def catalog():
    return {'models': {
        'gemini-3.8-flash-low': model('Gemini 3.8 Flash (Low)', 'MODEL_PLACEHOLDER_M320',
            supportsImages=True, supportsThinking=True, minThinkingBudget=32, thinkingLevel=1,
            supportsVideo=True, supportedMimeTypes={'image/png': True, 'video/mp4': True}),
        'gemini-3.5-flash-lite': model('Synthetic search model', 'MODEL_PLACEHOLDER_M50'),
        'gemini-3.1-flash-image': model('Gemini 3.1 Flash Image', 'MODEL_PLACEHOLDER_M21', supportsImages=True),
        'synthetic-video-summary': model('Synthetic video summary model', 'MODEL_PLACEHOLDER_M8',
            supportsVideo=True, supportedMimeTypes={'video/mp4': True}),
        }, 'defaultAgentModelId': 'gemini-3.8-flash-low',
        'agentModelSorts': [{'displayName': 'Synthetic', 'groups': [{'modelIds': ['gemini-3.8-flash-low']}]}],
        'webSearchModelIds': ['gemini-3.5-flash-lite'], 'imageGenerationModelIds': ['gemini-3.1-flash-image']}


def generated(parts, **extra):
    return {'response': {'candidates': [{'content': {'role': 'model', 'parts': parts}, 'finishReason': 'STOP', **extra}],
                         'usageMetadata': {'promptTokenCount': 20, 'candidatesTokenCount': 10, 'totalTokenCount': 30},
                         'modelVersion': 'synthetic-local-model', 'responseId': 'synthetic-response'}}


async def request(flow):
    global AGENT_CALLS, WEB_FETCH_SENT
    req = flow.request
    try:
        body = json.loads(req.content or b'{}')
    except ValueError:
        body = {key: values[0] if len(values) == 1 else values for key, values in parse_qs(req.get_text()).items()}
    path = urlsplit(req.pretty_url).path
    status, event_stream, response = 200, False, {}
    if path.endswith(':loadCodeAssist'):
        response = {'currentTier': {'id': 'free-tier'}, 'allowedTiers': [{'id': 'free-tier', 'isDefault': True}],
                    'cloudaicompanionProject': 'synthetic-project'}
    elif path.endswith(':fetchAvailableModels'):
        response = catalog()
    elif path.endswith(':rewriteUri'):
        response = {'redirectUri': 'https://example.invalid/article'}
    elif path.endswith(':checkUrlDenylist'):
        response = {'isDenied': False}
    elif path.endswith(':checkUrlAntivirus'):
        response = {'isClean': True}
    elif path.endswith(':fetchFromTrawlerCache'):
        response = {'content': '<html><head><title>Synthetic source</title></head><body><p>SYNTHETIC_SOURCE_SENTENCE: Blue circles are round.</p></body></html>'}
    elif path.endswith(':listExperiments'):
        response = {'experiments': []}
    elif path.endswith((':retrieveUserQuotaSummary', ':fetchUserInfo', ':getCodeAssistGlobalUserSetting', ':fetchAdminControls')):
        response = {}
    elif path == '/token' and req.host == 'oauth2.googleapis.com':
        response = {'access_token': 'synthetic-refreshed-token', 'refresh_token': 'synthetic-refresh-token',
                    'token_type': 'Bearer', 'expires_in': 3600}
    elif path == '/oauth2/v2/userinfo' and req.host == 'www.googleapis.com':
        response = {'id': 'synthetic-user', 'email': 'fixture@example.invalid', 'verified_email': True, 'name': 'Fixture'}
    elif path.endswith((':generateContent', ':streamGenerateContent')):
        event_stream = path.endswith(':streamGenerateContent')
        request_type = body.get('requestType')
        if request_type == 'web_search':
            response = generated([{'text': 'SYNTHETIC_SEARCH_RESULT: a blue circle on a white background.'}],
                groundingMetadata={'groundingChunks': [{'web': {'uri': 'https://example.invalid/synthetic', 'title': 'Synthetic fixture'}}]})
        elif request_type == 'video_summarization':
            response = generated([{'text': 'SYNTHETIC_VIDEO_SUMMARY: red then blue rectangles.'}])
        elif request_type == 'image_gen':
            # A known one-pixel synthetic PNG; no user image or external media.
            response = generated([{'inlineData': {'mimeType': 'image/png', 'data':
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SBAAAAAASUVORK5CYII='}}])
        elif request_type == 'checkpoint':
            response = generated([{'text': 'SYNTHETIC_CHECKPOINT: retain the pending synthetic request.'}])
        else:
            AGENT_CALLS += 1
            declarations = [declaration for tool in body.get('request', {}).get('tools', [])
                            for declaration in tool.get('functionDeclarations', [])]
            wanted = 'read_url_content' if SCENARIO == 'web-fetch' else 'search_web' if SCENARIO == 'web-search' else 'generate_image'
            declared = next((tool for tool in declarations if tool.get('name') == wanted), None)
            if declared and SCENARIO == 'web-fetch' and not WEB_FETCH_SENT:
                properties = declared.get('parameters', {}).get('properties', {})
                key = next((key for key in ('Url', 'url', 'URL') if key in properties), None)
                if key:
                    WEB_FETCH_SENT = True
                    response = generated([{'functionCall': {'name': wanted, 'id': 'synthetic-web-fetch-call', 'args': {key: 'https://example.invalid/article'}}, 'thoughtSignature': base64.b64encode(b'synthetic-official-probe-signature').decode()}])
                else:
                    response = generated([{'text': 'SYNTHETIC_URL_SCHEMA_NOT_RECOGNIZED'}])
            elif AGENT_CALLS == 1 and declared and SCENARIO == 'web-search':
                response = generated([{'functionCall': {'name': wanted,
                    'args': {'query': 'synthetic blue circle fixture', 'domain': 'example.invalid'},
                    'id': 'synthetic-search-call'}, 'thoughtSignature': base64.b64encode(b'synthetic-official-probe-signature').decode()}])
            elif AGENT_CALLS == 1 and declared and SCENARIO in ('image-tool', 'image-edit'):
                # These names/required fields were observed in the official declaration.
                arguments = {'Prompt': 'A synthetic blue circle on white.', 'ImageName': 'synthetic_blue_circle', 'AspectRatio': '1:1'}
                if SCENARIO == 'image-edit':
                    arguments['ImagePaths'] = [str(Path(os.environ['REQUEST_TYPES_WORK']) / 'synthetic-reference.png')]
                response = generated([{'functionCall': {'name': wanted,
                    'args': arguments,
                    'id': 'synthetic-image-call'}, 'thoughtSignature': base64.b64encode(b'synthetic-official-probe-signature').decode()}])
            else:
                response = generated([{'text': 'SYNTHETIC_PROBE_DONE' if declared else 'SYNTHETIC_TOOL_NOT_DECLARED'}])
    else:
        status, response = 404, {'error': {'code': 404, 'message': 'No forwarding: local request-type mock has no handler'}}
    record = {'method': req.method, 'url': req.pretty_url, 'version': req.http_version,
        'headers': [[key.decode('latin1'), '[REDACTED]' if SECRET.match(key.decode('latin1')) else value.decode('latin1')]
                    for key, value in req.headers.fields], 'body': clean(body), 'mockStatus': status, 'mockResponse': clean(response)}
    with (OUT / 'requests.jsonl').open('a') as journal:
        journal.write(json.dumps(record) + '\n')
    if SCENARIO == 'web-fetch' and body.get('requestType') == 'agent' and AGENT_CALLS == 1:
        # Keep print mode alive while the owned local Hub RPC is exercised.
        await asyncio.sleep(15)
    wire = ('data: ' + json.dumps(response) + '\n\n').encode() if event_stream else json.dumps(response).encode()
    flow.response = http.Response.make(status, wire, {'content-type': 'text/event-stream' if event_stream else 'application/json'})
