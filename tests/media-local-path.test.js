'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { MediaStore, localMediaOptions } = require('../src/multimedia');
const { serviceEnvironment } = require('../src/service-manager');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-path-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const allowed = path.join(root, 'inputs'), config = path.join(root, 'config');
  fs.mkdirSync(allowed); fs.mkdirSync(config);
  const target = path.join(allowed, 'clip.txt'); fs.writeFileSync(target, 'synthetic-media-only');
  return { root, allowed, config, target };
}

test('local media requires both an explicit enable switch and nonempty absolute allowed roots', async t => {
  const { allowed, config, target } = fixture(t);
  const defaults = localMediaOptions({ env: {}, configDir: config });
  assert.equal(defaults.allowLocalPaths, false); assert.deepEqual(defaults.allowedLocalRoots, []);
  await assert.rejects(new MediaStore({ directory: path.join(config, 'media'), ...defaults }).resolve({ filePath: target }), { code: 'media_local_path_not_allowed' });
  for (const value of [undefined, 'not-json', '[]', '{}', '["relative"]']) {
    assert.throws(() => localMediaOptions({ env: { ANTIGRAVITY_GATEWAY_MEDIA_LOCAL_PATHS: '1', ANTIGRAVITY_GATEWAY_MEDIA_ALLOWED_ROOTS: value }, configDir: config }), /ANTIGRAVITY_GATEWAY_MEDIA_ALLOWED_ROOTS/);
  }
  const env = { ANTIGRAVITY_GATEWAY_MEDIA_LOCAL_PATHS: '1', ANTIGRAVITY_GATEWAY_MEDIA_ALLOWED_ROOTS: JSON.stringify([allowed]) };
  assert.deepEqual(serviceEnvironment(env), env, 'normal background service snapshots preserve both policy settings');
  const store = new MediaStore({ directory: path.join(config, 'media'), ...localMediaOptions({ env, configDir: config }) });
  for (const part of [{ filePath: target }, { url: pathToFileURL(target).href }]) {
    const resolved = await store.resolve(part);
    assert.equal(Buffer.from(resolved.data, 'base64').toString(), 'synthetic-media-only');
    assert.equal(resolved.mediaType, 'text/plain');
  }
});

test('trusted local mode checks real paths, root boundaries and protected credential directories', async t => {
  const { root, allowed, config, target } = fixture(t);
  const outside = path.join(root, 'inputs-other'); fs.mkdirSync(outside);
  const external = path.join(outside, 'secret.txt'); fs.writeFileSync(external, 'synthetic-outside');
  const credential = path.join(config, 'account.json'); fs.writeFileSync(credential, 'synthetic-credential');
  const store = new MediaStore({ directory: path.join(config, 'media'), allowLocalPaths: true,
    allowedLocalRoots: [allowed], blockedLocalRoots: [config] });
  for (const candidate of [external, path.join(allowed, '..', 'inputs-other', 'secret.txt'), credential]) {
    await assert.rejects(store.resolve({ filePath: candidate }), { code: 'media_local_path_not_allowed' });
  }
  const alias = path.join(allowed, 'outside-link'); fs.symlinkSync(external, alias);
  await assert.rejects(store.resolve({ filePath: alias }), { code: 'media_local_path_not_allowed' });
  const folderAlias = path.join(allowed, 'credential-link'); fs.symlinkSync(config, folderAlias, 'dir');
  await assert.rejects(store.resolve({ filePath: path.join(folderAlias, 'account.json') }), { code: 'media_local_path_not_allowed' });
  const withinAlias = path.join(allowed, 'inside-link.txt'); fs.symlinkSync(target, withinAlias);
  assert.equal(Buffer.from((await store.resolve({ filePath: withinAlias })).data, 'base64').toString(), 'synthetic-media-only');

  const homeDir = path.join(root, 'synthetic-home'); fs.mkdirSync(homeDir);
  const ssh = path.join(homeDir, '.ssh'); fs.mkdirSync(ssh); fs.writeFileSync(path.join(ssh, 'key'), 'fake-key');
  fs.writeFileSync(path.join(homeDir, '.env'), 'SYNTHETIC=not-a-secret');
  const broad = new MediaStore({ directory: path.join(config, 'media'), ...localMediaOptions({ homeDir, configDir: config,
    env: { ANTIGRAVITY_GATEWAY_MEDIA_LOCAL_PATHS: '1', ANTIGRAVITY_GATEWAY_MEDIA_ALLOWED_ROOTS: JSON.stringify([root]) } }) });
  for (const candidate of [credential, path.join(folderAlias, 'account.json'), path.join(ssh, 'key'), path.join(homeDir, '.env')]) {
    await assert.rejects(broad.resolve({ filePath: candidate }), { code: 'media_local_path_not_allowed' });
  }
});

test('local path policy also covers tool-result media while inline tool images remain supported', async t => {
  const { config, target } = fixture(t);
  const store = new MediaStore({ directory: path.join(config, 'media') });
  const message = media => ({ messages: [{ role: 'user', parts: [{ type: 'tool_result', id: 'image-tool', media: [media] }] }] });
  await assert.rejects(store.resolveNormalized(message({ type: 'media', filePath: target })), { code: 'media_local_path_not_allowed' });
  const result = await store.resolveNormalized(message({ type: 'media', mediaType: 'image/png', data: Buffer.from('client-image-bytes').toString('base64') }));
  assert.equal(Buffer.from(result.messages[0].parts[0].media[0].data, 'base64').toString(), 'client-image-bytes');
});
