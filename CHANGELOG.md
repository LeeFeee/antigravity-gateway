# Changelog

## 0.1.2 - 2026-08-30

- Fixed Claude Code 2.1.251 requests being rejected by Cloud Code as `429 RESOURCE_EXHAUSTED` because of the newly injected standalone `You are a Claude agent, built on Anthropic's Claude Agent SDK.` provider marker. The gateway now replaces only that transport-specific identity line with a neutral compatibility identity and preserves the rest of the system prompt unchanged.
- Fixed Claude Code 2.1.251 built-in helper agents and Auto mode probes competing with the main session for the same high-capacity model route. Haiku aliases and detected Auto mode classifiers now select an available low-latency model by default.
- Added `ANTIGRAVITY_FAST_MODEL` for an explicit helper/classifier model override; exact entries in `ANTIGRAVITY_MODEL_ALIASES` still take precedence.
- Fixed direct transport stopping immediately on a `429 RESOURCE_EXHAUSTED` response from `daily-cloudcode`; retryable 429/5xx responses now try the normal Cloud Code endpoint and use one bounded exponential-backoff retry.
- Added `fast_model` to health/model discovery responses and show both default and auxiliary routes in the startup banner.
- Treat Claude Code cancellation of superseded classifier/tool requests as normal control flow instead of reporting a misleading gateway internal error.
- Added regression coverage for Haiku routing, Auto mode routing, daily-to-normal 429 fallback, and bounded retry recovery.

## 0.1.1 - 2026-08-23

- Added the gateway version to the startup banner, health response, `--help`, and `--version`, all sourced from `package.json`.
- Fixed direct-mode authentication on macOS by reading the official `gemini / antigravity` Keychain record before stale local session files.
- Fixed OAuth client-secret discovery so adjacent Mach-O bytes are not included in the secret; expired access tokens can now be refreshed directly without handing model requests to agy.
- Made native Cloud Code `direct` transport the default; missing credentials now fail explicitly instead of silently switching to the agy Agent transport.
- Added native Cloud Code transport that reuses the local Keychain/session state in memory, so requests can skip the `agy` Agent wrapper prompt without a second OAuth setup.
- Kept explicit auth JSON/access-token/refresh-token/project configuration as a documented manual fallback; refreshed local tokens are never written back by the gateway.
- Added local agy auth discovery, in-memory refresh, native request envelopes, Antigravity User-Agent/tool mode, function-call projection, and upstream text-delta forwarding.
- Added direct `fetchAvailableModels` discovery with daily-to-production fallback and a bounded timeout; explicit `ANTIGRAVITY_DIRECT_MODELS` still overrides discovery.
- Added a small minimum output budget for high/thinking models so low client caps do not consume the entire turn on hidden reasoning and return an empty visible message.
- Added live text SSE forwarding for plain Anthropic and Chat Completions requests; constrained tool, Auto mode, and structured-output requests remain buffered for validation.
- Added direct-provider unit coverage and documented the new transport and credential boundaries in both README languages.
- Normalized nullable/union tool schema types to the scalar schema format accepted by Cloud Code.
- Fixed native tool-history requests by removing Claude-only tool IDs from Gemini function-call parts.
- Preserved Cloud Code `thoughtSignature` values across Claude tool turns so follow-up requests can use prior native function calls.
- Added Gemini 3 thought-signature replay compatibility for stale Claude histories: real signatures are preserved, while a missing signature uses the first-call `skip_thought_signature_validator` sentinel and is not duplicated across parallel calls.
- Replaced the direct transport's XML tool-call envelope with typed `functionCall`/`functionResponse` mapping, including tool IDs, tool-name correlation, streamed argument assembly, and native tool-call validation.
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
