'use strict';

// Locate the installed CLI for OAuth client discovery only. Never execute it.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_AGY_COMMAND = 'agy';

function resolveAgyCommand(explicitPath, {
  platform = process.platform,
  env = process.env,
  homeDir = require('node:os').homedir()
} = {}) {
  if (explicitPath) return explicitPath;
  const candidates = platform === 'win32'
    ? [
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'),
        path.join(homeDir, 'AppData', 'Local', 'agy', 'bin', 'agy.exe')
      ]
    : [path.join(homeDir, '.local', 'bin', 'agy')];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || DEFAULT_AGY_COMMAND;
}

module.exports = { DEFAULT_AGY_COMMAND, resolveAgyCommand };
