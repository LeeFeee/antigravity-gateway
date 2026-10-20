'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { AgyImageStore, imageReferencePaths } = require('../src/agy-image-references');
const { buildDirectRequest } = require('../src/direct-provider');
const { newState, contentFingerprint } = require('../src/agy-session-state');
const { completeNativeContext } = require('../src/agy-context-state');
const { normalizeAnthropic } = require('../src/protocol');
const model = 'gemini-3.8-flash-high', data = Buffer.from('image fixture').toString('base64');
const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data } };
const user = { role: 'user', content: [{ type: 'text', text: 'Inspect the image.' }, image] };
function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-image-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new AgyImageStore({ directory, ...options });
}
function build(messages, state, store, now = 1792396521493) {
  const normalized = normalizeAnthropic({ messages }), native = { state, imageStore: store, now };
  const body = buildDirectRequest(normalized, model, 'project', 'session', '', null, native);
  return { body, normalized, native };
}

test('single image matches captured agy text/inlineData layout and keeps aliases entirely local', t => {
  const store = setup(t), state = newState('owner', 'session');
  const { body, normalized } = build([user], state, store);
  const parts = body.request.contents[0].parts, source = normalized.messages[0].parts[1], files = imageReferencePaths(source);
  assert.deepEqual(parts.map(Object.keys), [['text'], ['inlineData']]);
  assert.deepEqual(parts[1], { inlineData: { mimeType: 'image/png', data } });
  assert.equal(files.length, 1); assert.match(files[0], /\.user_uploaded[/\\]uploaded_media_1792396521493\.png$/);
  assert.deepEqual(fs.readFileSync(files[0]), Buffer.from(data, 'base64'));
  assert.equal(fs.statSync(files[0]).mode & 0o777, 0o600);
  const timestamp = state.timeline[0].timestamp;
  assert.equal(parts[0].text, `<USER_REQUEST>\nInspect the image.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: ${timestamp}.\n\nThe user has uploaded 1 image(s):\n- ${files[0]}\nYou can embed this image in an artifact if you need the USER to review it.\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nThe user changed setting \`Model Selection\` from None to Gemini 3.8 Flash (High). No need to comment on this change if the user doesn't ask about it. If reporting what model you are, please use a human readable name instead of the exact string.\n</USER_SETTINGS_CHANGE>`);
  assert.doesNotMatch(JSON.stringify(body), /attached_media|media_[a-f0-9]{32}|nativeImagePath|uploadedAt/);
  assert.ok(!JSON.stringify(normalized).includes(files[0]));
  assert.ok(!JSON.stringify(state).includes(data));
});

test('fresh parsing, provider state reload, cache eviction and dropped client signatures preserve image history', t => {
  const store = setup(t); let state = newState('owner', 'session');
  const first = build([user], state, store), raw = first.body.request.contents[0];
  completeNativeContext(state, first.native.context, model, { role: 'model', parts: [{ text: 'colors', thoughtSignature: 'real-signature' }] });
  const cached = imageReferencePaths(first.normalized.messages[0].parts[1])[0]; fs.unlinkSync(cached);
  state = JSON.parse(JSON.stringify(state));
  const second = build([user, { role: 'assistant', content: 'colors' }, { role: 'user', content: 'recall' }], state,
    new AgyImageStore({ directory: store.directory }), 1792396762811);
  assert.notEqual(first.normalized.messages[0].parts[1].id, second.normalized.messages[0].parts[1].id);
  assert.equal(contentFingerprint(first.native.context.sourceContents[0]), contentFingerprint(second.native.context.sourceContents[0]));
  assert.deepEqual(second.body.request.contents[0], raw);
  assert.equal(second.body.request.contents[1].parts[0].thoughtSignature, 'real-signature');
  assert.deepEqual(fs.readFileSync(cached), Buffer.from(data, 'base64'));
  assert.match(second.body.requestId, /\/3$/);
});

test('two images use native plural wording, ordered indexed filenames and preserve image bytes', t => {
  const store = setup(t), state = newState('owner', 'session');
  const { body, normalized } = build([{ role: 'user', content: [image, { type: 'text', text: 'two' }, image] }], state, store);
  const parts = body.request.contents[0].parts;
  const files = normalized.messages[0].parts.filter(p => p.type === 'media').flatMap(imageReferencePaths);
  assert.equal(parts.length, 3); assert.equal(files.length, 2);
  assert.match(files[0], /uploaded_media_0_1792396521493\.png$/); assert.match(files[1], /uploaded_media_1_1792396521493\.png$/);
  assert.ok(parts[0].text.includes(`The user has uploaded 2 image(s):\n- ${files[0]}\n- ${files[1]}\nYou can embed these images in an artifact if you need the USER to review them.\n</ADDITIONAL_METADATA>`));
  assert.ok(parts.slice(1).every(p => p.inlineData.data === data));
});

test('different messages and owner sessions cannot overwrite image cache paths', t => {
  const store = setup(t), state = newState('owner', 'session');
  const one = build([user, { role: 'assistant', content: 'first' }, { role: 'user', content: [image] }], state, store);
  const files = one.normalized.messages.flatMap(m => m.parts.filter(p => p.type === 'media').flatMap(imageReferencePaths));
  assert.equal(new Set(files).size, 2);
  const other = build([user], newState('other', 'session'), store);
  assert.notEqual(files[0], imageReferencePaths(other.normalized.messages[0].parts[1])[0]);
  assert.throws(() => store.save({ mimeType: 'image/png', data: Buffer.from('changed').toString('base64') },
    { cascadeId: state.cascadeId, uploadedAt: state.timeline[0].uploadedAt, index: 0, count: 1 }), /不一致/);
  assert.throws(() => store.save({ mimeType: 'image/png', data }, { cascadeId: '../escape', uploadedAt: 1, index: 0, count: 1 }), /无效/);
});

test('bounded cache cleanup protects current images and never touches ordinary uploads or foreign files', t => {
  let now = 1000; const store = setup(t, { now: () => now, ttlMs: 100, maxFiles: 1, maxBytes: 100 });
  const id = newState('a', 's').cascadeId, save = uploadedAt => store.save({ mimeType: 'image/png', data }, { cascadeId: id, uploadedAt, index: 0, count: 1 });
  const old = save(1); now = 1050; const recent = save(2);
  const foreign = path.join(path.dirname(recent), 'user-upload.bin'); fs.writeFileSync(foreign, 'preserve');
  store.cleanup(new Set([recent])); assert.ok(!fs.existsSync(old)); assert.ok(fs.existsSync(recent)); assert.ok(fs.existsSync(foreign));
  now = 1200; store.cleanup(); assert.ok(!fs.existsSync(recent)); assert.ok(fs.existsSync(foreign));
});

test('cache refuses symlink directories and cleanup does not follow them', t => {
  const store = setup(t), outside = setup(t), id = newState('a', 's').cascadeId;
  const file = path.join(outside.directory, 'preserve'); fs.writeFileSync(file, 'original');
  fs.symlinkSync(outside.directory, path.join(store.directory, id), 'dir');
  assert.throws(() => store.save({ mimeType: 'image/png', data }, { cascadeId: id, uploadedAt: 1, index: 0, count: 1 }), /普通目录/);
  store.cleanup(); assert.equal(fs.readFileSync(file, 'utf8'), 'original');
});
