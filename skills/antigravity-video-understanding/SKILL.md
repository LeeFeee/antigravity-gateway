---
name: antigravity-video-understanding
description: Analyze a local video through an existing Antigravity Gateway by uploading it and sending native input_video content. Use when the user asks an agent to inspect, summarize, explain, or answer questions about a video with this gateway.
---

# Antigravity Video Understanding

Use the bundled script instead of extracting frames first. It uploads the video through the gateway Files API, submits the returned file ID to Chat Completions as native `input_video`, prints the model's answer, and removes the temporary gateway upload after completion.

```bash
python3 scripts/analyze_video.py "/absolute/path/video.mp4" \
  --prompt "Analyze this video and answer the user's question."
```

The script accepts these connection settings:

- `--base-url` or `ANTIGRAVITY_GATEWAY_BASE_URL`; default: `http://127.0.0.1:9897`
- `--api-key` or `ANTIGRAVITY_GATEWAY_API_KEY`; default: `antigravity-gateway`
- `--model` or `ANTIGRAVITY_GATEWAY_MODEL`; default: `gemini-3.8-flash-high`

Pass the user's complete question through `--prompt`. The video may be local even when the gateway is remote because the script uploads its bytes first. Treat stdout as the final model answer. Report stderr to the user if the gateway rejects the media; do not silently replace native video understanding with frame extraction.

Use `--keep-upload` only when the returned file ID must be reused in another request.
