'use strict';

// Request identity is observable metadata. It never authorizes changing a
// prompt, tools, permissions, or the upstream chosen by the caller.
function clientRuntime(req) {
  const headers = req?.headers || {};
  const userAgent = headers['user-agent'];
  if (typeof userAgent !== 'string' || /[\r\n]/.test(userAgent)) return null;
  const claude = /^claude-cli\/(\d+\.\d+\.\d+)(?:\s|\(|$)/.exec(userAgent);
  if (claude) return { client: 'claude', version: claude[1], entrypoint: 'cli', source: 'user-agent' };
  const pi = /^pi\/(\d+\.\d+\.\d+)(?:\s|$)/.exec(userAgent);
  if (pi) return { client: 'pi', version: pi[1], entrypoint: 'cli', source: 'user-agent' };
  const dsh = /^deepseek-harness\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/.exec(userAgent);
  if (dsh) return { client: 'dsh', version: dsh[1], entrypoint: 'harness', source: 'user-agent' };

  const originator = headers.originator;
  const codex = /^(codex_exec|codex-tui)\/(\d+\.\d+\.\d+)(?:\s|$)/.exec(userAgent);
  if (codex && codex[1] === originator) {
    return { client: 'codex', version: codex[2], entrypoint: codex[1], source: 'user-agent+originator' };
  }
  const desktop = /^Codex Desktop\/(\d+\.\d+\.\d+) \([^\r\n]+\) [^\r\n]*\((codex_exec|codex-tui); (\d+\.\d+\.\d+)\)$/.exec(userAgent);
  if (originator === 'Codex Desktop' && desktop && desktop[1] === desktop[3]) {
    return { client: 'codex', version: desktop[3], entrypoint: desktop[2] === 'codex-tui' ? 'desktop-tui' : 'desktop-exec', source: 'user-agent+originator' };
  }
  // A generic SDK User-Agent cannot establish an agent's identity/version.
  // For example, Hermes's installed version belongs to the local manifest.
  return null;
}

module.exports = { clientRuntime };
