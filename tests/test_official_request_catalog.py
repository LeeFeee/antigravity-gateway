"""Offline checks for official binary/request evidence; never starts agy or sends HTTP."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'tests/fixtures'
spec = importlib.util.spec_from_file_location('official_proto', ROOT / 'scripts/catalog-official-protobuf.py')
proto = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proto)


def load(name):
    return json.loads((FIXTURES / name).read_text())


def bindings(rules):
    for rule in rules:
        yield rule.get('method'), rule.get('path')
        yield from bindings(rule.get('additionalBindings', []))


class OfficialCatalogTests(unittest.TestCase):
    def test_wire_decoder_rejects_truncation_and_handles_negative_enum(self):
        for data in (b'\x0a\x08x', b'\x80', b'\x00', b'\x0f'):
            with self.assertRaises(ValueError):
                proto.fields(data)
        self.assertEqual(proto.signed_int32((1 << 64) - 1), -1)

    def test_http_bindings_cover_every_independently_located_annotation(self):
        dictionary = load('antigravity-1.5.2-protobuf-rpc-dictionary.json')
        inventory = load('antigravity-1.5.2-static-rpc-inventory.json')
        actual = {pair for item in dictionary['methods'] for pair in bindings(item['http'])
                  if pair[1].startswith('/v1internal')}
        expected = {(item['method'], item['path']) for item in inventory['httpAnnotations']}
        self.assertEqual(actual, expected)
        self.assertEqual(len(actual), 66)
        self.assertEqual(len(dictionary['methods']), 64)
        self.assertEqual(dictionary['unresolvedTypes'], [])

    def test_nested_types_are_closed_and_proto_oneofs_maps_are_preserved(self):
        dictionary = load('antigravity-1.5.2-protobuf-rpc-dictionary.json')
        types = dictionary['messages'].keys() | dictionary['enums'].keys()
        for message in dictionary['messages'].values():
            for field in message['fields']:
                if field.get('typeName'):
                    self.assertIn(field['typeName'], types)
                if 'oneofIndex' in field:
                    self.assertLess(field['oneofIndex'], len(message['oneofs']))
        self.assertTrue(any(item['mapEntry'] for item in dictionary['messages'].values()))
        self.assertTrue(any(item['oneofs'] for item in dictionary['messages'].values()))
        search = dictionary['messages']['.google.cloud.aiplatform.master.Tool.GoogleSearch']
        names = {field['jsonName'] for field in search['fields']}
        self.assertTrue({'includedDomains', 'excludeDomains', 'enhancedContent'} <= names)
        self.assertNotIn('maxUses', names)

    def test_official_search_tool_reaches_search_request_and_result_continuation(self):
        result = load('official-request-types-20261107/web-search-v2.json')
        self.assertIsNone(result['failure'])
        self.assertFalse(result['realUpstream'])
        requests = [item for item in result['requests'] if item['body'].get('requestType') == 'web_search']
        self.assertEqual(len(requests), 1)
        body = requests[0]['body']
        self.assertEqual(body['model'], 'gemini-3.5-flash-lite')
        self.assertEqual(body['request']['tools'][0]['googleSearch']['includedDomains'], ['example.invalid'])
        receipts = [part['functionResponse'] for item in result['requests']
                    for content in item['body'].get('request', {}).get('contents', [])
                    for part in content.get('parts', []) if 'functionResponse' in part]
        self.assertTrue(any('SYNTHETIC_SEARCH_RESULT' in part['response'].get('output', '') for part in receipts))

    def test_image_gen_tracks_official_parent_trajectory_and_attaches_result(self):
        for name in ('image-tool-v1', 'image-edit-v1'):
            result = load(f'official-request-types-20261107/{name}.json')
            self.assertIsNone(result['failure'])
            generated = next(item['body'] for item in result['requests'] if item['body'].get('requestType') == 'image_gen')
            parent = next(item['body'] for item in result['requests'] if item['body'].get('requestType') == 'agent')
            self.assertEqual(generated['requestId'].split('/')[-2], parent['request']['labels']['trajectory_id'])
            self.assertEqual(generated['requestId'].split('/')[-1], '2')
            self.assertNotIn('labels', generated['request'])
            parts = generated['request']['contents'][0]['parts']
            self.assertEqual(len(parts), 2 if name == 'image-edit-v1' else 1)
            receipts = [part['functionResponse'] for item in result['requests']
                        for content in item['body'].get('request', {}).get('contents', [])
                        for part in content.get('parts', []) if 'functionResponse' in part]
            self.assertTrue(any(part.get('parts', [{}])[0].get('inlineData', {}).get('mimeType') == 'image/png' for part in receipts))
            self.assertTrue(any('Generated image is saved at ' in part['response'].get('output', '') for part in receipts))

    def test_video_callback_sends_original_mp4_to_fixed_summary_model(self):
        result = load('official-request-types-20261107/video-summary-v7.json')
        self.assertIsNone(result['failure'])
        local = [item for item in result['acp'] if item.get('localHubMethod')]
        self.assertEqual([(item['localHubMethod'], item['status']) for item in local],
                         [('StartCascade', 200), ('SendUserCascadeMessage', 200)])
        generated = next(item['body'] for item in result['requests'] if item['body'].get('requestType') == 'video_summarization')
        self.assertEqual(generated['model'], 'synthetic-video-summary')
        parts = generated['request']['contents'][0]['parts']
        original = (FIXTURES / 'gateway-media-inputs/video-fixture.mp4').read_bytes()
        actual = base64.b64decode(parts[0]['inlineData']['data'])
        self.assertEqual(hashlib.sha256(actual).digest(), hashlib.sha256(original).digest())
        self.assertEqual(parts[0]['inlineData']['mimeType'], 'video/mp4')
        self.assertIn('Describe this video', parts[1]['text'])
        self.assertEqual(generated['request']['generationConfig'], {'candidateCount': 1})


if __name__ == '__main__':
    unittest.main()
