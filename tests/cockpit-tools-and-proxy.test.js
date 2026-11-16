'use strict';

require('./helpers/gateway-environment');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createServer } = require('../antigravity-gateway');
const { AccountPool } = require('../src/account-pool');
const { AccountStore } = require('../src/account-store');
const { AgyNativeTransport, closeNativeTransport, resolveNativeBinary } = require('../src/agy-native-transport');
const { QuotaManager } = require('../src/quota-manager');
const {
  COCKPIT_TOOLS_OAUTH_CLIENT_ID,
  importCockpitToolsAccounts,
  previewCockpitToolsImport,
  scanCockpitToolsAccounts
} = require('../src/cockpit-tools-import');
const { dashboardAsset, dashboardHtml } = require('../src/dashboard');
const { LocalAgyAuthProvider } = require('../src/local-agy-auth');
const { ProxyConfigManager, redactProxyUrl, shouldBypassProxy, validateProxyUrl } = require('../src/proxy-config');

function makeTempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }));
  return dir;
}

function encryptEnvelope(keyBytes, payload, extra = { kind: 'antigravity', key_id: 'test-key' }) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes, nonce);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    ...extra,
    algorithm: 'AES-256-GCM',
    nonce: nonce.toString('base64'),
    ciphertext: Buffer.concat([encrypted, tag]).toString('base64'),
    encrypted_at: Math.floor(Date.now() / 1000)
  };
}

test('cockpit-tools-import scans & decrypts AES-256-GCM, legacy token_encrypted, and plaintext exports while skipping disabled/pending', (t) => {
  const homeDir = makeTempDir(t, 'agw-cockpit-home-');
  const mainDir = path.join(homeDir, '.cockpit_tools');
  const legacyDir = path.join(homeDir, '.antigravity_cockpit');
  fs.mkdirSync(path.join(mainDir, 'accounts'), { recursive: true });
  fs.mkdirSync(path.join(legacyDir, 'accounts'), { recursive: true });

  const secureKey = crypto.randomBytes(32);
  const tokenKey = crypto.randomBytes(32);
  fs.writeFileSync(path.join(mainDir, 'secure-account-storage.key'), secureKey.toString('base64'));
  fs.writeFileSync(path.join(legacyDir, 'account-token.key'), tokenKey.toString('base64'));

  // 1. Modern AES-256-GCM whole-file envelope
  fs.writeFileSync(
    path.join(mainDir, 'accounts', 'acc-1.json'),
    JSON.stringify(encryptEnvelope(secureKey, {
      id: 'acc-1',
      email: 'Alice@Example.com',
      disabled: false,
      pending_oauth: false,
      created_at: 1700000000,
      last_used: 1700001000,
      token: {
        access_token: 'access-alice',
        refresh_token: 'refresh-alice-new',
        expires_in: 3600,
        expiry_timestamp: 1800000000,
        project_id: 'proj-alice'
      }
    }))
  );

  // 2. Older mirror of same email in legacy dir (lower last_used -> mainDir wins)
  fs.writeFileSync(
    path.join(legacyDir, 'accounts', 'acc-1.json'),
    JSON.stringify({
      id: 'acc-1',
      email: 'alice@example.com',
      last_used: 1700000100,
      token: { access_token: 'access-old', refresh_token: 'refresh-alice-old' }
    })
  );

  // 3. Legacy token_encrypted account + UTF-8 BOM
  fs.writeFileSync(
    path.join(legacyDir, 'accounts', 'acc-2.json'),
    '\uFEFF' + JSON.stringify({
      id: 'acc-2',
      email: 'bob@example.com',
      token_encrypted: encryptEnvelope(tokenKey, {
        access_token: 'access-bob',
        refresh_token: 'refresh-bob',
        expires_in: 3600,
        expiry_timestamp: 1800000000,
        token_type: 'Bearer',
        project_id: 'proj-bob'
      })
    })
  );

  // 4. Disabled & pending_oauth should be skipped
  fs.writeFileSync(
    path.join(mainDir, 'accounts', 'acc-disabled.json'),
    JSON.stringify({ id: 'd1', email: 'off@example.com', disabled: true, token: { refresh_token: 'rt' } })
  );
  fs.writeFileSync(
    path.join(mainDir, 'accounts', 'acc-pending.json'),
    JSON.stringify({ id: 'p1', email: 'pending@example.com', pending_oauth: true, token: { refresh_token: 'rt' } })
  );
  // Backup file should be ignored
  fs.writeFileSync(
    path.join(mainDir, 'accounts', 'acc-1.json.bak'),
    JSON.stringify({ id: 'bak', email: 'bak@example.com', token: { refresh_token: 'rt' } })
  );

  const scan = scanCockpitToolsAccounts({ homeDir, env: {} });
  assert.equal(scan.candidates.length, 2);
  assert.equal(scan.skipped.disabled, 1);
  assert.equal(scan.skipped.pendingOauth, 1);
  assert.equal(scan.errors.length, 0);

  const configDir = makeTempDir(t, 'agw-store-');
  const store = new AccountStore({ configDir });
  const preview = previewCockpitToolsImport({ store, homeDir, env: {} });
  assert.equal(preview.totalFound, 2);
  assert.equal(preview.newCount, 2);
  assert.equal(JSON.stringify(preview).includes('refresh-alice-new'), false);
  assert.equal(JSON.stringify(preview).includes('access-bob'), false);

  let poolReloads = 0;
  const result1 = importCockpitToolsAccounts({
    store,
    pool: { reload: () => { poolReloads += 1; } },
    homeDir,
    env: {}
  });
  assert.equal(result1.imported, 2);
  assert.equal(result1.updated, 0);
  assert.equal(poolReloads, 1);

  const saved = store.list();
  assert.equal(saved.length, 2);
  const alice = saved.find(a => a.email === 'Alice@Example.com');
  assert.equal(alice.refreshToken, 'refresh-alice-new');
  assert.equal(alice.projectId, 'proj-alice');
  assert.equal(alice.clientId, COCKPIT_TOOLS_OAUTH_CLIENT_ID);
  assert.equal(alice.source, 'cockpit-tools');

  // Re-running without changes skips unchanged accounts
  const result2 = importCockpitToolsAccounts({ store, homeDir, env: {} });
  assert.equal(result2.imported, 0);
  assert.equal(result2.unchanged, 2);

  // Batch JSON file import via explicit path
  const exportFile = path.join(homeDir, 'export.json');
  fs.writeFileSync(exportFile, JSON.stringify({
    accounts: [{ email: 'carol@example.com', token: { access_token: 'ac', refresh_token: 'rc', project_id: 'pc' } }]
  }));
  const result3 = importCockpitToolsAccounts({ store, dataDir: exportFile, env: {} });
  assert.equal(result3.imported, 1);
  assert.equal(store.list().length, 3);
});

test('LocalAgyAuthProvider prioritizes preferredClientId when refreshing imported accounts', async () => {
  const seenClientIds = [];
  const provider = new LocalAgyAuthProvider({
    clientCredentials: [
      { clientId: 'other-client', clientSecret: 'other-secret' },
      { clientId: COCKPIT_TOOLS_OAUTH_CLIENT_ID, clientSecret: 'matching-secret' }
    ],
    preferredClientId: COCKPIT_TOOLS_OAUTH_CLIENT_ID,
    useKeychain: false,
    authFile: '__test__',
    fetchImpl: async (_url, options) => {
      const form = new URLSearchParams(String(options.body));
      seenClientIds.push(form.get('client_id'));
      return new Response(JSON.stringify({ access_token: 'new-access', expires_in: 3600 }), { status: 200 });
    }
  });
  const updated = await provider.refresh(undefined, 'rt-123');
  assert.equal(updated.accessToken, 'new-access');
  assert.deepEqual(seenClientIds, [COCKPIT_TOOLS_OAUTH_CLIENT_ID]);
});

test('CLI --import-cockpit-tools imports accounts cleanly into isolated CONFIG_DIR', (t) => {
  const root = makeTempDir(t, 'agw-cli-cockpit-');
  const configDir = path.join(root, 'gw-config');
  const exportFile = path.join(root, 'accounts-export.json');
  fs.writeFileSync(exportFile, JSON.stringify([{ email: 'cli@example.com', token: { refresh_token: 'rt-cli', access_token: 'at-cli' } }]));

  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, '../antigravity-gateway.js'), '--import-cockpit-tools', '--cockpit-dir', exportFile],
    {
      env: { ...process.env, ANTIGRAVITY_GATEWAY_CONFIG_DIR: configDir },
      encoding: 'utf8'
    }
  );
  assert.match(output, /新增 1/);
  assert.equal(output.includes('rt-cli'), false);
  const store = new AccountStore({ configDir });
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].email, 'cli@example.com');
});

test('ProxyConfigManager validates URLs, persists safely, redacts passwords, toggles env, and proxies mediaFetch', async (t) => {
  const configDir = makeTempDir(t, 'agw-proxy-cfg-');
  const fakeEnv = { HTTPS_PROXY: 'http://env-proxy:8888', https_proxy: 'http://env-proxy:8888', NO_PROXY: 'localhost' };
  const initialEnv = { ...fakeEnv };
  let appliedCount = 0;

  assert.throws(() => validateProxyUrl('ftp://127.0.0.1:7897'));
  assert.throws(() => validateProxyUrl('http://127.0.0.1:7897\r\nBad: 1'));
  assert.equal(redactProxyUrl('http://alice:topsecret@127.0.0.1:7897/'), 'http://alice:********@127.0.0.1:7897');
  assert.equal(shouldBypassProxy('https://api.internal.local/v1', 'localhost,.internal.local'), true);
  assert.equal(shouldBypassProxy('https://example.com/a', 'localhost,.internal.local'), false);

  const manager = new ProxyConfigManager({
    configDir,
    env: fakeEnv,
    initialEnv,
    onApplied: () => { appliedCount += 1; }
  });
  assert.equal(manager.publicState().source, 'environment');
  assert.equal(manager.publicState().enabled, true);

  assert.throws(() => manager.save({ enabled: true, proxyUrl: '' }));
  const savedState = manager.save({
    enabled: true,
    proxyUrl: 'http://user:s3cr3t@127.0.0.1:7897',
    noProxy: '127.0.0.1, localhost, .corp.local',
    mediaUseProxy: true
  });
  assert.equal(appliedCount, 1);
  assert.equal(savedState.source, 'saved');
  assert.equal(savedState.hasPassword, true);
  assert.equal(savedState.proxyUrl, 'http://user:********@127.0.0.1:7897');
  assert.equal(fakeEnv.HTTPS_PROXY, 'http://user:s3cr3t@127.0.0.1:7897');
  assert.equal(fakeEnv.NO_PROXY, '127.0.0.1,localhost,.corp.local');

  // Updating noProxy with masked URL preserves stored password
  manager.save({ enabled: true, proxyUrl: savedState.proxyUrl, noProxy: '127.0.0.1', mediaUseProxy: true });
  assert.equal(fakeEnv.HTTPS_PROXY, 'http://user:s3cr3t@127.0.0.1:7897');

  // Local HTTP proxy test for mediaFetch
  const proxySeen = [];
  const targetServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('from-upstream');
  });
  const proxyServer = http.createServer((req, res) => {
    proxySeen.push(req.url);
    const parsed = new URL(req.url);
    const upstreamReq = http.request({ host: parsed.hostname, port: parsed.port, path: parsed.pathname, method: req.method }, upRes => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    });
    req.pipe(upstreamReq);
  });
  await new Promise(resolve => targetServer.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    targetServer.closeAllConnections(); proxyServer.closeAllConnections();
    await Promise.all([new Promise(r => targetServer.close(r)), new Promise(r => proxyServer.close(r))]);
  });

  manager.save({
    enabled: true,
    proxyUrl: `http://127.0.0.1:${proxyServer.address().port}`,
    noProxy: 'localhost',
    mediaUseProxy: true
  });
  const proxiedRes = await manager.mediaFetch(`http://127.0.0.1:${targetServer.address().port}/asset.png`);
  assert.equal(proxiedRes.status, 200);
  assert.equal(await proxiedRes.text(), 'from-upstream');
  assert.equal(proxySeen.length, 1);

  // Explicit disable removes proxy env
  const disabled = manager.save({ enabled: false, proxyUrl: savedState.proxyUrl, noProxy: 'localhost', mediaUseProxy: false });
  assert.equal(disabled.enabled, false);
  assert.equal(fakeEnv.HTTPS_PROXY, undefined);

  // Reset removes proxy.json and restores initial launch env
  const reset = manager.reset();
  assert.equal(reset.configured, false);
  assert.equal(reset.source, 'environment');
  assert.equal(fakeEnv.HTTPS_PROXY, 'http://env-proxy:8888');
});

test('Dashboard HTTP routes gate & execute proxy updates and Cockpit Tools import with CSRF protection', async (t) => {
  t.mock.method(QuotaManager.prototype, 'refreshAccount', async () => null);
  const html = dashboardHtml();
  assert.match(html, /id="openProxySettings"/);
  assert.match(html, /id="importCockpitToolsBtn"/);
  assert.match(html, /id="proxyConfigDialog"/);
  assert.match(html, /id="cockpitImportDialog"/);
  const toolsScriptUrl = html.match(/<script src="([^"]*dashboard-tools\.js[^"]*)"/)?.[1];
  assert.ok(toolsScriptUrl);
  assert.notEqual(toolsScriptUrl, '/dashboard/assets/dashboard-tools.js');
  assert.ok(dashboardAsset('dashboard-tools.js').body.length > 100);

  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    closeNativeTransport();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  // Fetch CSRF token via GET /dashboard/proxy
  const proxyGet = await fetch(`${base}/dashboard/proxy`);
  assert.equal(proxyGet.status, 200);
  const initial = await proxyGet.json();
  assert.ok(initial.csrfToken);

  // Reject missing CSRF on POST /dashboard/proxy & import
  assert.equal((await fetch(`${base}/dashboard/proxy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, proxyUrl: 'http://127.0.0.1:7897' })
  })).status, 403);
  assert.equal((await fetch(`${base}/dashboard/accounts/cockpit-tools/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
  })).status, 403);

  // Reject invalid proxy URL with 400
  const invalidPost = await fetch(`${base}/dashboard/proxy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dashboard-csrf': initial.csrfToken },
    body: JSON.stringify({ enabled: true, proxyUrl: 'not-a-url' })
  });
  assert.equal(invalidPost.status, 400);

  // Valid save + reset cycle
  const validPost = await fetch(`${base}/dashboard/proxy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dashboard-csrf': initial.csrfToken },
    body: JSON.stringify({ enabled: true, proxyUrl: 'http://127.0.0.1:7899', noProxy: '127.0.0.1,localhost', mediaUseProxy: false })
  });
  assert.equal(validPost.status, 200);
  const savedBody = await validPost.json();
  assert.equal(savedBody.enabled, true);
  assert.equal(savedBody.activeEffectiveProxy, 'http://127.0.0.1:7899');

  const resetRes = await fetch(`${base}/dashboard/proxy`, {
    method: 'DELETE',
    headers: { 'x-dashboard-csrf': initial.csrfToken }
  });
  assert.equal(resetRes.status, 200);
  assert.equal((await resetRes.json()).configured, false);

  // Cockpit Tools scan & import via Dashboard HTTP endpoints
  const fixtureDir = makeTempDir(t, 'agw-http-cockpit-');
  fs.mkdirSync(path.join(fixtureDir, 'accounts'), { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, 'accounts', 'd1.json'), JSON.stringify({
    id: 'd1',
    email: 'dash-import@example.com',
    token: { access_token: 'at-dash', refresh_token: 'rt-dash', project_id: 'proj-dash' }
  }));

  const scanRes = await fetch(`${base}/dashboard/accounts/cockpit-tools/scan?dataDir=${encodeURIComponent(fixtureDir)}`);
  assert.equal(scanRes.status, 200);
  const scanJson = await scanRes.json();
  assert.equal(scanJson.totalFound, 1);
  assert.equal(scanJson.accounts[0].email, 'dash-import@example.com');
  assert.equal(JSON.stringify(scanJson).includes('rt-dash'), false);

  const importRes = await fetch(`${base}/dashboard/accounts/cockpit-tools/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dashboard-csrf': initial.csrfToken },
    body: JSON.stringify({ dataDir: fixtureDir })
  });
  assert.equal(importRes.status, 200);
  const importJson = await importRes.json();
  assert.equal(importJson.imported, 1);
  assert.equal(JSON.stringify(importJson).includes('rt-dash'), false);

  const dashData = await (await fetch(`${base}/dashboard/data`)).json();
  assert.ok(dashData.accounts.some(a => a.email === 'dash-import@example.com'));
  assert.equal(JSON.stringify(dashData).includes('rt-dash'), false);
});

test('Go native bridge honors updated HTTPS_PROXY after transport restart', async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-native-proxy-'));
  const binary = resolveNativeBinary({ cacheDir });
  let connectSeen = '';
  const proxyServer = http.createServer();
  proxyServer.on('connect', (req, socket) => {
    connectSeen = req.url;
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));

  const transport = new AgyNativeTransport({
    binaryPath: binary,
    env: {
      ...process.env,
      HTTPS_PROXY: `http://127.0.0.1:${proxyServer.address().port}`,
      NO_PROXY: '',
      no_proxy: ''
    }
  });
  t.after(async () => {
    const child = transport.child;
    const exited = child && child.exitCode === null && child.signalCode === null
      ? new Promise(resolve => child.once('exit', resolve))
      : Promise.resolve();
    proxyServer.closeAllConnections();
    await new Promise(resolve => proxyServer.close(resolve));
    transport.close();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1000))]);
    fs.rmSync(cacheDir, { recursive: true, force: true, maxRetries: 15, retryDelay: 30 });
  });

  await assert.rejects(
    transport.fetch('https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'),
    { name: 'NativeTransportError' }
  );
  assert.equal(connectSeen, 'daily-cloudcode-pa.googleapis.com:443');
});
