#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MIN_NODE_MAJOR = 20;
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux', 'win32']);
const SUPPORTED_ARCHITECTURES = new Set(['arm64', 'x64']);

function fail(message) {
  console.error(`[Antigravity Gateway] Environment check failed: ${message}`);
  process.exitCode = 1;
}

function main() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
    fail(`Node.js ${MIN_NODE_MAJOR}+ is required; current version is ${process.version}`);
    return;
  }
  if (!SUPPORTED_PLATFORMS.has(process.platform)) {
    fail(`unsupported operating system: ${process.platform}`);
    return;
  }
  if (!SUPPORTED_ARCHITECTURES.has(process.arch)) {
    fail(`unsupported CPU architecture: ${process.arch}`);
    return;
  }

  let probeDir;
  try {
    probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-gateway-check-'));
    fs.writeFileSync(path.join(probeDir, 'write-test'), 'ok', { mode: 0o600 });
  } catch (error) {
    fail(`the operating-system temporary directory is not writable: ${error.message}`);
    return;
  } finally {
    if (probeDir) fs.rmSync(probeDir, { recursive: true, force: true });
  }

  console.log(`[Antigravity Gateway] Environment ready: Node ${process.versions.node}, ${process.platform}/${process.arch}`);
  console.log('[Antigravity Gateway] Runtime dependencies are managed automatically by npm.');
}

main();
