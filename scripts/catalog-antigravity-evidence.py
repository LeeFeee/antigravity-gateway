#!/usr/bin/env python3
"""Build a credential-free RPC inventory from existing request captures, offline."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit


def shape(value, depth=0):
    if depth > 7:
        return type(value).__name__
    if isinstance(value, dict):
        # Model names are data keys. A representative entry avoids copying an
        # account's whole model catalog while retaining its response structure.
        if len(value) > 16:
            first = next(iter(value.values()))
            return {'<map-value>': shape(first, depth + 1)}
        return {key: shape(item, depth + 1) for key, item in value.items()}
    if isinstance(value, list):
        return [shape(value[0], depth + 1)] if value else []
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'boolean'
    if isinstance(value, (int, float)):
        return 'number'
    return 'string'


def response_body(value):
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except ValueError:
        for line in value.splitlines():
            if line.startswith('data: '):
                try:
                    return json.loads(line[6:])
                except ValueError:
                    pass
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', action='append', required=True, metavar='LABEL=DIR')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--agy', type=Path)
    args = parser.parse_args()
    inventory = {}
    for entry in args.source:
        label, separator, directory = entry.partition('=')
        if not separator or not label:
            parser.error('--source must be LABEL=DIR')
        root = Path(directory)
        if not root.is_dir():
            parser.error('capture directory does not exist: ' + directory)
        for file in sorted(root.rglob('*.request.json')):
            request = json.loads(file.read_text())
            url = urlsplit(request.get('url', ''))
            body = request.get('body') or {}
            request_type = body.get('requestType') if isinstance(body, dict) else None
            key = (label, request.get('method', 'POST'), url.hostname, url.path, request_type)
            item = inventory.setdefault(key, {'source': label, 'method': key[1], 'host': url.hostname,
                'path': url.path, 'query': url.query, 'requestType': request_type,
                'requestCount': 0, 'responseStatuses': Counter(), 'missingResponses': 0,
                'sampleRequests': [], 'requestShape': shape(body), 'responseShape': None})
            item['requestCount'] += 1
            if len(item['sampleRequests']) < 2:
                item['sampleRequests'].append(str(file.relative_to(root)))
            response_file = file.with_name(file.name.replace('.request.json', '.response.json'))
            if response_file.exists():
                response = json.loads(response_file.read_text())
                item['responseStatuses'][str(response.get('status'))] += 1
                if item['responseShape'] is None:
                    item['responseShape'] = shape(response_body(response.get('body')))
            else:
                item['missingResponses'] += 1
    data = {'protocol': 'Google Antigravity API', 'operation': 'offline inventory; no upstream calls',
            'entries': list(inventory.values())}
    if args.agy:
        data['binarySha256'] = hashlib.sha256(args.agy.read_bytes()).hexdigest()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'requestGroups': len(inventory), 'requests': sum(x['requestCount'] for x in inventory.values()),
                      'output': str(args.output)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
