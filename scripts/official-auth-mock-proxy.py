"""All-response local proxy for probe-official-auth.py; never forwards a request."""
import json
import os
import re
from pathlib import Path
from urllib.parse import parse_qs, parse_qsl, urlencode, urlsplit, urlunsplit

from mitmproxy import http

OUT = Path(os.environ['AUTH_PROBE_OUT'])
SECRET = re.compile(r'^(authorization|cookie|set-cookie|client_secret|access_token|refresh_token|id_token|code_verifier|code|state|code_challenge)$', re.I)
ONBOARDED = False
ONBOARD_COUNT = 0


def clean(value):
    if isinstance(value, dict):
        return {key: '[REDACTED]' if SECRET.match(key) and isinstance(item, str) else clean(item)
                for key, item in value.items()}
    if isinstance(value, list):
        return [clean(item) for item in value]
    return value


def request(flow):
    global ONBOARDED, ONBOARD_COUNT
    req = flow.request
    try:
        body = json.loads(req.content or b'{}')
    except ValueError:
        body = {key: values[0] if len(values) == 1 else values
                for key, values in parse_qs(req.get_text()).items()}
    url = urlsplit(req.pretty_url)
    query = {key: '[REDACTED]' if SECRET.match(key) else value for key, value in parse_qsl(url.query)}
    path = url.path
    status = 200
    if path.endswith(':loadCodeAssist'):
        response = {'allowedTiers': [{'id': 'free-tier', 'isDefault': True}]}
        if ONBOARDED:
            response.update({'currentTier': {'id': 'free-tier'}, 'cloudaicompanionProject': 'synthetic-onboard-project'})
    elif path.endswith(':onboardUser'):
        ONBOARD_COUNT += 1
        ONBOARDED = True
        response = {'name': 'operations/synthetic-onboard', 'done': True, 'response': {
            '@type': 'type.googleapis.com/google.internal.cloud.code.v1internal.OnboardUserResponse',
            'cloudaicompanionProject': {'id': 'synthetic-onboard-project'}}}
        if os.environ.get('AUTH_PROBE_SCENARIO') == 'onboard-pending' and ONBOARD_COUNT == 1:
            response = {'name': 'operations/synthetic-onboard', 'done': False}
    elif '/operations/' in path:
        response = {'name': 'operations/synthetic-onboard', 'done': True, 'response': {
            '@type': 'type.googleapis.com/google.internal.cloud.code.v1internal.OnboardUserResponse',
            'cloudaicompanionProject': {'id': 'synthetic-onboard-project'}}}
    elif path.endswith(':fetchAvailableModels'):
        # No valid generation model is offered: this probe stops after auth/eligibility.
        response = {'models': {}, 'modelSorts': []}
    elif path.endswith(':retrieveUserQuotaSummary'):
        response = {}
    elif path.endswith(':listExperiments'):
        response = {'experiments': []}
    elif path.endswith(':fetchUserInfo'):
        response = {}
    elif path == '/token' and req.host == 'oauth2.googleapis.com':
        response = {'access_token': 'synthetic-refreshed-token', 'refresh_token': 'synthetic-refresh-token',
                    'token_type': 'Bearer', 'expires_in': 3600}
    elif path == '/oauth2/v2/userinfo' and req.host == 'www.googleapis.com':
        response = {'id': 'synthetic-user', 'email': 'fixture@example.invalid', 'verified_email': True, 'name': 'Fixture'}
    else:
        status = 404
        response = {'error': {'code': 404, 'message': 'All-mock proxy does not implement this endpoint'}}
    record = {'method': req.method,
              'url': urlunsplit((url.scheme, url.netloc, path, urlencode(query), '')),
              'version': req.http_version,
              'headers': [[key.decode('latin1'), '[REDACTED]' if SECRET.match(key.decode('latin1')) else value.decode('latin1')]
                          for key, value in req.headers.fields],
              'body': clean(body), 'mockResponse': clean(response), 'mockStatus': status}
    with (OUT / 'requests.jsonl').open('a', encoding='utf8') as journal:
        journal.write(json.dumps(record) + '\n')
    # Lazy connection mode plus this unconditional response avoids contacting the URL host.
    # Seatbelt separately prohibits non-loopback network access for the proxy and client.
    flow.response = http.Response.make(status, json.dumps(response).encode(), {'content-type': 'application/json'})
