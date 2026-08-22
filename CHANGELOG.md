# Changelog

## Unreleased

- Removed maintainer-specific absolute paths and resolve `agy` from the current user's `PATH` by default.
- Moved transient workspaces and logs from the source tree to a per-user operating-system temporary directory, with an environment-variable override.
- Reworked the bilingual README for arbitrary installation directories, account-specific model discovery, and macOS/Linux/Windows environment configuration.
- Added a global CLI installation flow so users can install in one command and run `antigravity-gateway` from any directory.
- Added an npm lifecycle environment check for Node.js, supported operating systems/architectures, and writable temporary storage.
- Added fallback discovery for the official per-user `agy` install locations when the current shell has not reloaded its updated `PATH`.
- Documented Node.js/npm bootstrap commands for macOS, Linux, and Windows.

## 0.1.0 - 2026-08-22

- Added official `agy` headless subprocess adapter with Keyring-session reuse.
- Added Anthropic Messages, OpenAI Responses, and Chat Completions endpoints.
- Added OpenAI and Codex-compatible model catalogs.
- Added experimental client tool projection and result round trips.
- Added Claude Code Auto mode XML and JSON Schema normalization.
- Added process isolation, environment filtering, concurrency limits, cancellation, SSE heartbeats, and log cleanup.
- Verified real Gemini responses, Claude Code text/tool loops, and Codex CLI basic Responses usage.
