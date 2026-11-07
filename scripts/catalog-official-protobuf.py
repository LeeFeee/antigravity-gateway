#!/usr/bin/env python3
"""Read embedded FileDescriptorProto records without importing/executing agy.

Dependency-free protobuf wire decoder. Only contiguous, validated descriptor
records beginning with name/package are admitted; the resulting dictionary is
compiled-schema evidence, not proof that any CLI path calls a service method.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re


def varint(data, pos, end):
    value = 0
    for shift in range(0, 70, 7):
        if pos >= end:
            raise ValueError('Truncated varint')
        byte = data[pos]
        pos += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, pos
    raise ValueError('Oversized varint')


def wire_field(data, pos, end):
    tag, pos = varint(data, pos, end)
    number, kind = tag >> 3, tag & 7
    if not number:
        raise ValueError('Zero field number')
    if kind == 0:
        value, pos = varint(data, pos, end)
    elif kind == 2:
        size, pos = varint(data, pos, end)
        if pos + size > end:
            raise ValueError('Truncated bytes')
        value, pos = data[pos:pos + size], pos + size
    elif kind in (1, 5):
        size = 8 if kind == 1 else 4
        if pos + size > end:
            raise ValueError('Truncated fixed width')
        value, pos = data[pos:pos + size], pos + size
    else:
        raise ValueError('Unsupported descriptor wire type')
    return number, kind, value, pos


def fields(data):
    pos, out = 0, {}
    while pos < len(data):
        number, _, value, pos = wire_field(data, pos, len(data))
        out.setdefault(number, []).append(value)
    return out


def text(values, number, default=''):
    value = values.get(number, [default])[0]
    return value.decode('utf8') if isinstance(value, bytes) else value


def embedded_files(binary):
    found, starts = [], set()
    # A file name is immediately followed by the package (field 2). Dependencies
    # use field 3 and therefore do not match this boundary.
    for match in re.finditer(rb'\.proto\x12', binary):
        filename_end = match.start() + 6
        for start in range(max(0, filename_end - 300), filename_end):
            if binary[start] != 10 or start in starts:
                continue
            try:
                length, name_start = varint(binary, start + 1, filename_end)
            except ValueError:
                continue
            name = binary[name_start:filename_end]
            if name_start + length != filename_end or not re.fullmatch(rb'[A-Za-z0-9_./-]+\.proto', name):
                continue
            pos, seen, values = start, set(), {}
            allowed = {1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 7: 2, 8: 2, 9: 2, 10: 0, 11: 0, 12: 2, 14: 0}
            while pos < min(len(binary), start + 16 * 1024 * 1024):
                try:
                    number, kind, value, after = wire_field(binary, pos, len(binary))
                except ValueError:
                    break
                if number not in allowed or kind != allowed[number] or (number in (1, 2, 8, 9, 12, 14) and number in seen):
                    break
                values.setdefault(number, []).append(value)
                seen.add(number)
                pos = after
            try:
                package = text(values, 2)
                if text(values, 1) != name.decode() or not re.fullmatch(r'[A-Za-z0-9_.]+', package):
                    continue
                # Validate every nested message/service/enum before admitting a file.
                for number in (4, 5, 6):
                    for entry in values.get(number, []):
                        fields(entry)
            except (ValueError, UnicodeDecodeError):
                continue
            starts.add(start)
            found.append({'file': name.decode(), 'package': package, 'offset': start, 'end': pos, 'fields': values})
            break
    return found


SCALARS = {1: 'double', 2: 'float', 3: 'int64', 4: 'uint64', 5: 'int32', 6: 'fixed64', 7: 'fixed32',
           8: 'bool', 9: 'string', 10: 'group', 11: 'message', 12: 'bytes', 13: 'uint32', 14: 'enum',
           15: 'sfixed32', 16: 'sfixed64', 17: 'sint32', 18: 'sint64'}


def field_record(blob):
    value = fields(blob)
    options = fields(value[8][0]) if 8 in value else {}
    result = {'name': text(value, 1), 'number': text(value, 3), 'jsonName': text(value, 10),
              'label': {1: 'optional', 2: 'required', 3: 'repeated'}.get(text(value, 4), 'unspecified'),
              'type': SCALARS.get(text(value, 5), f'unknown:{text(value, 5)}')}
    for number, key in ((6, 'typeName'), (7, 'default'), (9, 'oneofIndex'), (17, 'proto3Optional')):
        if number in value:
            result[key] = text(value, number)
    if 3 in options:
        result['deprecated'] = bool(text(options, 3))
    if 1052 in options:
        behavior_names = {0: 'UNSPECIFIED', 1: 'OPTIONAL', 2: 'REQUIRED', 3: 'OUTPUT_ONLY',
                          4: 'INPUT_ONLY', 5: 'IMMUTABLE', 6: 'UNORDERED_LIST', 7: 'NON_EMPTY_DEFAULT', 8: 'IDENTIFIER'}
        behaviors = []
        for item in options[1052]:
            if isinstance(item, bytes):
                pos = 0
                while pos < len(item):
                    behavior, pos = varint(item, pos, len(item))
                    behaviors.append(behavior)
            else:
                behaviors.append(item)
        result['fieldBehavior'] = [behavior_names.get(item, str(item)) for item in behaviors]
    if 72295728 in options:
        result['http'] = 'unexpected-field-http-annotation'
    return result


def collect_types(files):
    messages, enums = {}, {}

    def enum(blob, prefix, source):
        value = fields(blob)
        enums[f'{prefix}.{text(value, 1)}'] = {'source': source, 'values': [
            {'name': text(fields(item), 1), 'number': signed_int32(text(fields(item), 2))} for item in value.get(2, [])]}

    def message(blob, prefix, source):
        value = fields(blob)
        name = f'{prefix}.{text(value, 1)}'
        options = fields(value[7][0]) if 7 in value else {}
        messages[name] = {'source': source, 'fields': [field_record(item) for item in value.get(2, [])],
                          'oneofs': [text(fields(item), 1) for item in value.get(8, [])],
                          'mapEntry': bool(text(options, 7, 0))}
        for item in value.get(3, []):
            message(item, name, source)
        for item in value.get(4, []):
            enum(item, name, source)

    for file in files:
        prefix = '.' + file['package']
        for item in file['fields'].get(4, []):
            message(item, prefix, file['file'])
        for item in file['fields'].get(5, []):
            enum(item, prefix, file['file'])
    return messages, enums


def signed_int32(value):
    value &= 0xffffffff
    return value - (1 << 32) if value & (1 << 31) else value


def http_rule(blob):
    value, result = fields(blob), {}
    for number, verb in ((2, 'GET'), (3, 'PUT'), (4, 'POST'), (5, 'DELETE'), (6, 'PATCH')):
        if number in value:
            result.update({'method': verb, 'path': text(value, number)})
    if 7 in value:
        result['body'] = text(value, 7)
    if 12 in value:
        result['responseBody'] = text(value, 12)
    if 11 in value:
        result['additionalBindings'] = [http_rule(item) for item in value[11]]
    return result


def catalog(binary):
    candidates = embedded_files(binary)
    files, rejected = [], []
    for file in candidates:
        try:
            local_messages, local_enums = collect_types([file])
            for name in [*local_messages, *local_enums]:
                if not re.fullmatch(r'\.[A-Za-z_][A-Za-z0-9_.]*', name):
                    raise ValueError('Invalid descriptor type name')
        except (ValueError, UnicodeDecodeError, TypeError) as error:
            rejected.append({'file': file['file'], 'offset': hex(file['offset']), 'reason': str(error)})
            continue
        files.append(file)
    messages, enums = collect_types(files)
    methods, additional_grpc = [], []
    for file in files:
        for service in file['fields'].get(6, []):
            service = fields(service)
            for item in service.get(2, []):
                method = fields(item)
                options = fields(method[4][0]) if 4 in method else {}
                rules = [http_rule(item) for item in options.get(72295728, [])]
                service_name = file['package'] + '.' + text(service, 1)
                if service_name == 'google.gca.aicode.v1main.PredictionService' and text(method, 1) == 'BidiGenerateContent':
                    additional_grpc.append({'name': text(method, 1), 'service': service_name,
                        'request': text(method, 2), 'response': text(method, 3), 'source': file['file'],
                        'clientStreaming': bool(text(method, 5, 0)), 'serverStreaming': bool(text(method, 6, 0)),
                        'evidence': 'compiled v1main descriptor; audio code references a v1alpha URL, not dynamically verified'})
                if not any(rule.get('path', '').startswith('/v1internal') for rule in rules):
                    continue
                methods.append({'name': text(method, 1), 'service': service_name,
                    'source': file['file'], 'request': text(method, 2), 'response': text(method, 3), 'http': rules,
                    'clientStreaming': bool(text(method, 5, 0)), 'serverStreaming': bool(text(method, 6, 0)),
                    'evidence': 'compiled protobuf definition; runtime reachability is not asserted'})
    internal_requests = ['.exa.api_server_pb.GetVideoSummarizationRequest', '.exa.api_server_pb.GetImageGenerationRequest',
                         '.exa.api_server_pb.GetWebSearchResultsRequest']
    # Long-running Operation carries Any: its concrete onboarding result cannot
    # be discovered by following type_name alone.
    operation_results = ['.google.internal.cloud.code.v1internal.OnboardUserResponse']
    required, queue = set(), [name for method in [*methods, *additional_grpc] for name in (method['request'], method['response'])]
    queue += [name for name in [*internal_requests, *operation_results] if name in messages]
    while queue:
        name = queue.pop()
        if name in required:
            continue
        required.add(name)
        for field in messages.get(name, {}).get('fields', []):
            if field.get('typeName'):
                queue.append(field['typeName'])
    return {'binarySha256': hashlib.sha256(binary).hexdigest(), 'evidence': 'static-only; binary not executed',
        'descriptorCount': len(files), 'rpcCount': len(methods), 'rejectedDescriptorCandidates': rejected,
        'files': [{'name': file['file'], 'package': file['package'], 'offset': hex(file['offset']),
                   'length': file['end'] - file['offset'], 'sha256': hashlib.sha256(binary[file['offset']:file['end']]).hexdigest(),
                   'syntax': text(file['fields'], 12, 'proto2'),
                   'dependencies': [item.decode() for item in file['fields'].get(3, [])]} for file in files
                  if file['file'] in {entry['source'] for entry in [*methods, *additional_grpc]} | {messages[name]['source'] for name in required if name in messages}],
        'methods': methods,
        'additionalGrpcDefinitions': additional_grpc,
        'internalRequestDefinitions': [name for name in internal_requests if name in messages],
        'operationResultDefinitions': [name for name in operation_results if name in messages],
        'messages': {name: messages[name] for name in sorted(required) if name in messages},
        'enums': {name: enums[name] for name in sorted(required) if name in enums},
        'unresolvedTypes': sorted(required - messages.keys() - enums.keys())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, default=Path.home() / '.local/bin/agy')
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    result = catalog(args.binary.read_bytes())
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({key: result[key] for key in ('binarySha256', 'descriptorCount', 'rpcCount', 'unresolvedTypes')}))


if __name__ == '__main__':
    main()
