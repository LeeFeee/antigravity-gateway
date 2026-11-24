'use strict';

// Names identify captured translation rule lineages, not allowed runtime versions.
const CODEX_167_CLIENT_PROFILE = 'codex-cli-0.167.2';
const CODEX_171_CLIENT_PROFILE = 'codex-cli-0.171.0';
const CODEX_COMPATIBLE_CLIENT_PROFILE = 'codex-cli-compatible';
const SEMVER = '(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?)';

// Request identity is observable metadata. It never authorizes changing a
// prompt, tools, permissions, or the upstream chosen by the caller.
function clientRuntime(req) {
  const headers = req?.headers || {};
  const userAgent = headers['user-agent'];
  if (typeof userAgent !== 'string' || /[\r\n]/.test(userAgent)) return null;
  const claude = new RegExp('^claude-cli/' + SEMVER + '(?:\\s|\\(|$)').exec(userAgent);
  if (claude) return { client: 'claude', version: claude[1], entrypoint: 'cli', source: 'user-agent' };
  const pi = new RegExp('^pi/' + SEMVER + '(?:\\s|$)').exec(userAgent);
  if (pi) return { client: 'pi', version: pi[1], entrypoint: 'cli', source: 'user-agent' };
  const dsh = new RegExp('^deepseek-harness/' + SEMVER + '(?:\\s|$)').exec(userAgent);
  if (dsh) return { client: 'dsh', version: dsh[1], entrypoint: 'harness', source: 'user-agent' };

  const originator = headers.originator;
  const codex = new RegExp('^(codex_exec|codex-tui)/' + SEMVER + '(?:\\s|$)').exec(userAgent);
  if (codex && codex[1] === originator) {
    return { client: 'codex', version: codex[2], entrypoint: codex[1], source: 'user-agent+originator' };
  }
  const desktop = new RegExp('^Codex Desktop/' + SEMVER + ' \\([^\\r\\n]+\\) [^\\r\\n]*\\((codex_exec|codex-tui); ' + SEMVER + '\\)$').exec(userAgent);
  if (originator === 'Codex Desktop' && desktop) {
    return { client: 'codex', version: desktop[3], ...(desktop[1] !== desktop[3] ? { launcherVersion: desktop[1] } : {}),
      entrypoint: desktop[2] === 'codex-tui' ? 'desktop-tui' : 'desktop-exec', source: 'user-agent+originator' };
  }
  // A generic SDK User-Agent cannot establish an agent's identity/version.
  // For example, Hermes's installed version belongs to the local manifest.
  return null;
}

module.exports = { clientRuntime, CODEX_167_CLIENT_PROFILE, CODEX_171_CLIENT_PROFILE, CODEX_COMPATIBLE_CLIENT_PROFILE };
