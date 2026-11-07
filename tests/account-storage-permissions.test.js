'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AccountStore } = require('../src/account-store');
const { AccountStoragePermissions } = require('../src/account-storage-permissions');

test('accounts stay private with umask 022, including temporary writes, old files and atomic replacement', t => {
  if (process.platform === 'win32') return t.skip('POSIX mode verification; Windows DACL uses its separate contract test');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-account-modes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const writes = [];
  const fsImpl = { ...fs, writeFileSync(file, data, options) {
    fs.writeFileSync(file, data, options);
    writes.push({ mode: fs.statSync(file).mode & 0o777, temporary: file.endsWith('.tmp') });
  } };
  const previous = process.umask(0o022);
  try {
    const store = new AccountStore({ configDir: root, fsImpl });
    const saved = store.save({ email: 'synthetic@example.invalid', accessToken: 'fake', refreshToken: 'fake-refresh' });
    const target = path.join(store.directory, 'synthetic-example.invalid.json');
    assert.equal(fs.statSync(store.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    fs.chmodSync(store.directory, 0o755); fs.chmodSync(target, 0o644);
    assert.equal(store.list().length, 1);
    assert.equal(fs.statSync(store.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    store.updateCredentials(saved, { accessToken: 'refreshed' });
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.ok(writes.length >= 2 && writes.every(write => write.temporary && write.mode === 0o600));
    assert.equal(fs.readdirSync(store.directory).some(name => name.endsWith('.tmp')), false);
  } finally { process.umask(previous); }
});

test('credential storage does not chmod or follow symlink account files', t => {
  if (process.platform === 'win32') return t.skip('Creating symlinks requires optional Windows privileges');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-account-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new AccountStore({ configDir: root }); store.ensureDirectory();
  const outside = path.join(root, 'outside'); fs.writeFileSync(outside, 'canary', { mode: 0o644 });
  fs.symlinkSync(outside, path.join(store.directory, 'symlink.json'));
  assert.throws(() => store.list(), /不能使用符号链接/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'canary');
  assert.equal(fs.statSync(outside).mode & 0o777, 0o644);
});

test('Windows credentials require a verified protected DACL instead of POSIX chmod', () => {
  const commands = [], file = "C:\\Users\\O'Brien\\accounts";
  const stat = { dev: 1, ino: 2, size: 1, ctimeMs: 3, mtimeMs: 4,
    isSymbolicLink: () => false, isDirectory: () => true, isFile: () => true };
  const permissions = new AccountStoragePermissions({ platform: 'win32',
    fsImpl: { lstatSync: () => stat, chmodSync: () => assert.fail('chmod is not a Windows ACL') },
    execFileSyncImpl: (binary, args, options) => commands.push({ binary, args, options }) });
  permissions.directory(file); permissions.directory(file);
  assert.equal(commands.length, 1, 'unchanged ACL-protected paths need no repeated PowerShell process');
  const command = commands[0];
  assert.equal(command.binary, 'powershell.exe');
  assert.deepEqual(command.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(command.options.windowsHide, true); assert.ok(command.options.timeout > 0);
  const script = Buffer.from(command.args[4], 'base64').toString('utf16le');
  assert.match(script, /O''Brien/);
  assert.match(script, /SetAccessRuleProtection\(\$true,\$false\)/);
  assert.match(script, /ContainerInherit, ObjectInherit/);
  assert.match(script, /AreAccessRulesProtected/); assert.match(script, /\$rules.Count -ne 1/);
  assert.match(script, /IdentityReference.Value -ne \$sid.Value/);
  stat.ctimeMs++;
  permissions.file(file);
  assert.equal(commands.length, 2, 'replaced or modified credential files are protected again');
  assert.match(Buffer.from(commands[1].args[4], 'base64').toString('utf16le'), /FileSecurity/);
});

test('Windows ACL setup failure propagates and is never cached as success', () => {
  let attempts = 0;
  const stat = { isSymbolicLink: () => false, isFile: () => true };
  const permissions = new AccountStoragePermissions({ platform: 'win32', fsImpl: { lstatSync: () => stat },
    execFileSyncImpl: () => { attempts++; throw new Error('ACL denied'); } });
  assert.throws(() => permissions.file('C:\\private\\account.json'), /ACL denied/);
  assert.throws(() => permissions.file('C:\\private\\account.json'), /ACL denied/);
  assert.equal(attempts, 2);
});
