#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'native');
const go = process.env.ANTIGRAVITY_BUILD_GO || 'go';
const version = execFileSync(go, ['version'], { encoding: 'utf8' }).trim();
if (!/\bgo1\.27\.2\b/.test(version)) throw new Error('Use Go 1.27.2 to build the captured agy 1.4.2 transport profile.');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const targets = [
  ['darwin', 'arm64', 'darwin', 'arm64'], ['darwin', 'x64', 'darwin', 'amd64'],
  ['linux', 'arm64', 'linux', 'arm64'], ['linux', 'x64', 'linux', 'amd64'],
  ['win32', 'arm64', 'windows', 'arm64'], ['win32', 'x64', 'windows', 'amd64']
];
const only = process.argv.includes('--current') ? `${process.platform}-${process.arch}` : '';
const output = path.join(source, 'bin');
fs.mkdirSync(output, { recursive: true });
const manifest = { protocol: 1, goVersion: 'go1.27.2', profile: 'agy-1.4.2',
  sourceSha256: sha(Buffer.concat(['go.mod', 'main.go'].map(f => fs.readFileSync(path.join(source, f))))), platforms: {} };
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-native-build-'));
try {
  for (const [platform, arch, goos, goarch] of targets) {
    const target = `${platform}-${arch}`;
    if (only && target !== only) continue;
    const binary = path.join(temporary, `transport-${target}${platform === 'win32' ? '.exe' : ''}`);
    console.log(`Building native transport ${target}`);
    execFileSync(go, ['build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -buildid=', '-o', binary, '.'], {
      cwd: source, stdio: 'inherit', env: { ...process.env, GOTOOLCHAIN: 'local', CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch }
    });
    const bytes = fs.readFileSync(binary), compressed = zlib.gzipSync(bytes, { level: 9 });
    const file = `agy-transport-${target}.gz`;
    fs.writeFileSync(path.join(output, file), compressed);
    manifest.platforms[target] = { file, bytes: bytes.length, sha256: sha(bytes), compressedSha256: sha(compressed) };
  }
  fs.writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const goroot = execFileSync(go, ['env', 'GOROOT'], { encoding: 'utf8' }).trim();
  fs.copyFileSync(path.join(goroot, 'LICENSE'), path.join(source, 'GO-LICENSE'));
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
