# Changelog

## Unreleased

- Added an auto-selected native Cloud Code transport that first reuses the local agy session files (`jetski-standalone-oauth-token` / `oauth_creds.json`) in memory, so requests can skip the `agy` Agent wrapper prompt without a second OAuth setup.
- Kept explicit auth JSON/access-token/refresh-token/project configuration as a documented manual fallback; refreshed local tokens are never written back by the gateway.
- Added local agy auth discovery, in-memory refresh, native request envelopes, Antigravity User-Agent/tool mode, function-call projection, and upstream text-delta forwarding.
- Added direct `fetchAvailableModels` discovery with daily-to-production fallback and a bounded timeout; explicit `ANTIGRAVITY_DIRECT_MODELS` still overrides discovery.
- Added a small minimum output budget for high/thinking models so low client caps do not consume the entire turn on hidden reasoning and return an empty visible message.
- Added live text SSE forwarding for plain Anthropic and Chat Completions requests; constrained tool, Auto mode, and structured-output requests remain buffered for validation.
- Added direct-provider unit coverage and documented the new transport and credential boundaries in both README languages.
- Added direct-upstream context budgeting: large tool output and stale history are compacted before Cloud Code requests, and nullable/union tool schema types are normalized to the scalar schema format accepted by the upstream.
- Upstream HTTP 400 diagnostics now include the sanitized provider reason instead of only a generic gateway error.
- Removed maintainer-specific absolute paths and resolve `agy` from the current user's `PATH` by default.
- Moved transient workspaces and logs from the source tree to a per-user operating-system temporary directory, with an environment-variable override.
- Reworked the bilingual README for arbitrary installation directories, account-specific model discovery, and macOS/Linux/Windows environment configuration.
- Added a global CLI installation flow so users can install in one command and run `antigravity-gateway` from any directory.
- Added an npm lifecycle environment check for Node.js, supported operating systems/architectures, and writable temporary storage.
- Added fallback discovery for the official per-user `agy` install locations when the current shell has not reloaded its updated `PATH`.
- Documented Node.js/npm bootstrap commands for macOS, Linux, and Windows.
- Switched the GitHub install command to the branch tarball URL for reliable npm lifecycle execution without requiring a Git checkout.

## 0.1.0 - 2026-08-22

- Added official `agy` headless subprocess adapter with Keyring-session reuse.
- Added Anthropic Messages, OpenAI Responses, and Chat Completions endpoints.
- Added OpenAI and Codex-compatible model catalogs.
- Added experimental client tool projection and result round trips.
- Added Claude Code Auto mode XML and JSON Schema normalization.
- Added process isolation, environment filtering, concurrency limits, cancellation, SSE heartbeats, and log cleanup.
- Verified real Gemini responses, Claude Code text/tool loops, and Codex CLI basic Responses usage.
