#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const RESTART_DELAY_MS = 3000;

function readConfiguration(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || !value.environment || typeof value.environment !== 'object') {
    throw new Error('后台服务配置无效。');
  }
  return Object.fromEntries(Object.entries(value.environment).filter(([, item]) => typeof item === 'string'));
}

function rotate(file) {
  try {
    if (fs.statSync(file).size < MAX_LOG_BYTES) return;
    const previous = `${file}.1`;
    try { fs.rmSync(previous, { force: true }); } catch { /* best effort */ }
    fs.renameSync(file, previous);
  } catch { /* a missing log needs no rotation */ }
}

function appendFailure(file, error) {
  try {
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${error.stack || error.message || error}\n`, { encoding: 'utf8' });
  } catch { /* the service supervisor will still observe the non-zero exit */ }
}

function main(argv = process.argv.slice(2)) {
  const [configurationFile, gatewayFile, stdoutFile, stderrFile] = argv;
  if (![configurationFile, gatewayFile, stdoutFile, stderrFile].every(Boolean)) {
    process.stderr.write('service-runner requires configuration, gateway, stdout, and stderr paths\n');
    process.exitCode = 2;
    return;
  }

  let environment;
  try {
    environment = readConfiguration(configurationFile);
    fs.mkdirSync(path.dirname(stdoutFile), { recursive: true, mode: 0o700 });
    rotate(stdoutFile);
    if (stderrFile !== stdoutFile) rotate(stderrFile);
  } catch (error) {
    appendFailure(stderrFile, error);
    process.exitCode = 1;
    return;
  }

  const stdout = fs.openSync(stdoutFile, 'a');
  const stderr = stderrFile === stdoutFile ? stdout : fs.openSync(stderrFile, 'a');
  let stopping = false;
  let child = null;
  let restartTimer = null;

  const closeLogs = () => {
    try { fs.closeSync(stdout); } catch { /* already closed */ }
    if (stderr !== stdout) {
      try { fs.closeSync(stderr); } catch { /* already closed */ }
    }
  };

  const launch = () => {
    if (stopping) return;
    child = spawn(process.execPath, [gatewayFile], {
      cwd: environment.HOME || process.cwd(),
      env: { ...process.env, ...environment },
      stdio: ['ignore', stdout, stderr],
      windowsHide: true
    });
    child.once('error', (error) => appendFailure(stderrFile, error));
    child.once('close', (code, signal) => {
      child = null;
      if (stopping) {
        closeLogs();
        process.exitCode = 0;
        return;
      }
      appendFailure(stderrFile, new Error(`Gateway exited unexpectedly (code=${code}, signal=${signal || 'none'}); restarting in ${RESTART_DELAY_MS}ms`));
      restartTimer = setTimeout(launch, RESTART_DELAY_MS);
    });
  };

  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    if (restartTimer) clearTimeout(restartTimer);
    if (child && !child.killed) child.kill(signal);
    else {
      closeLogs();
      process.exitCode = 0;
    }
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
  launch();
}

if (require.main === module) main();

module.exports = { MAX_LOG_BYTES, RESTART_DELAY_MS, main, readConfiguration, rotate };
