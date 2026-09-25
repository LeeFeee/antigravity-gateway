#!/usr/bin/env python3
"""Upload a video to Antigravity Gateway and request native video analysis."""

from __future__ import annotations

import argparse
import http.client
import json
import mimetypes
import os
from pathlib import Path
import sys
import uuid
from urllib.parse import quote, urlsplit


MIME_OVERRIDES = {
    ".avi": "video/x-msvideo",
    ".m4v": "video/x-m4v",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".mp4": "video/mp4",
    ".mpeg": "video/mpeg",
    ".mpg": "video/mpeg",
    ".webm": "video/webm",
}


class GatewayRequestError(RuntimeError):
    pass


def gateway_root(value: str) -> str:
    root = value.strip().rstrip("/")
    if root.endswith("/v1"):
        root = root[:-3]
    parsed = urlsplit(root)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("gateway base URL must be an absolute http(s) URL")
    return root.rstrip("/")


def connection_for(url: str, timeout: float):
    parsed = urlsplit(url)
    connection_type = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    return connection_type(parsed.hostname, parsed.port, timeout=timeout), parsed


def response_json(response: http.client.HTTPResponse) -> dict:
    body = response.read()
    try:
        payload = json.loads(body.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError):
        payload = {"raw": body.decode("utf-8", errors="replace")}
    if response.status < 200 or response.status >= 300:
        detail = payload.get("error", payload)
        if isinstance(detail, dict):
            detail = detail.get("message") or detail.get("code") or json.dumps(detail, ensure_ascii=False)
        raise GatewayRequestError(f"gateway returned HTTP {response.status}: {detail}")
    return payload


def authorization_headers(api_key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {api_key}"} if api_key else {}


def upload_video(base_url: str, api_key: str, video: Path, media_type: str, timeout: float) -> dict:
    boundary = f"----antigravity-{uuid.uuid4().hex}"
    safe_name = "video" + video.suffix.lower()
    prefix = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="purpose"\r\n\r\n'
        "assistants\r\n"
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{safe_name}"\r\n'
        f"Content-Type: {media_type}\r\n\r\n"
    ).encode("utf-8")
    suffix = f"\r\n--{boundary}--\r\n".encode("utf-8")
    url = f"{base_url}/v1/files"
    connection, parsed = connection_for(url, timeout)
    target = parsed.path or "/"
    if parsed.query:
        target += f"?{parsed.query}"
    try:
        connection.putrequest("POST", target)
        connection.putheader("Content-Type", f"multipart/form-data; boundary={boundary}")
        connection.putheader("Content-Length", str(len(prefix) + video.stat().st_size + len(suffix)))
        for name, value in authorization_headers(api_key).items():
            connection.putheader(name, value)
        connection.endheaders()
        connection.send(prefix)
        with video.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                connection.send(chunk)
        connection.send(suffix)
        return response_json(connection.getresponse())
    finally:
        connection.close()


def json_request(method: str, url: str, api_key: str, payload: dict | None, timeout: float) -> dict:
    connection, parsed = connection_for(url, timeout)
    target = parsed.path or "/"
    if parsed.query:
        target += f"?{parsed.query}"
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = authorization_headers(api_key)
    if body is not None:
        headers["Content-Type"] = "application/json; charset=utf-8"
        headers["Content-Length"] = str(len(body))
    try:
        connection.request(method, target, body=body, headers=headers)
        return response_json(connection.getresponse())
    finally:
        connection.close()


def message_text(response: dict) -> str:
    try:
        content = response["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as error:
        raise GatewayRequestError("gateway response does not contain choices[0].message.content") from error
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        texts = [str(item.get("text", "")) for item in content if isinstance(item, dict) and item.get("text")]
        if texts:
            return "\n".join(texts)
    raise GatewayRequestError("gateway returned an empty video analysis result")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Analyze a local video through Antigravity Gateway.")
    parser.add_argument("video", help="Path to a local video file")
    parser.add_argument("--prompt", default="请分析这段视频，准确概括内容并回答用户的问题。")
    parser.add_argument("--base-url", default=os.environ.get("ANTIGRAVITY_GATEWAY_BASE_URL", "http://127.0.0.1:9897"))
    parser.add_argument("--api-key", default=os.environ.get("ANTIGRAVITY_GATEWAY_API_KEY", "antigravity-gateway"))
    parser.add_argument("--model", default=os.environ.get("ANTIGRAVITY_GATEWAY_MODEL", "gemini-3.8-flash-high"))
    parser.add_argument("--timeout", type=float, default=600.0, help="Request timeout in seconds")
    parser.add_argument("--keep-upload", action="store_true", help="Do not delete the uploaded gateway file")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    video = Path(args.video).expanduser().resolve()
    if not video.is_file():
        print(f"video file does not exist: {video}", file=sys.stderr)
        return 2
    media_type = MIME_OVERRIDES.get(video.suffix.lower()) or mimetypes.guess_type(video.name)[0] or "application/octet-stream"
    if not media_type.startswith("video/"):
        print(f"unsupported video MIME type: {media_type}", file=sys.stderr)
        return 2
    file_id = ""
    try:
        base_url = gateway_root(args.base_url)
        uploaded = upload_video(base_url, args.api_key, video, media_type, args.timeout)
        file_id = str(uploaded.get("id", ""))
        if not file_id:
            raise GatewayRequestError("gateway file upload did not return an id")
        response = json_request("POST", f"{base_url}/v1/chat/completions", args.api_key, {
            "model": args.model,
            "stream": False,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": args.prompt},
                    {"type": "input_video", "file_id": file_id, "mime_type": media_type},
                ],
            }],
        }, args.timeout)
        print(message_text(response))
        return 0
    except (GatewayRequestError, OSError, ValueError) as error:
        print(f"video analysis failed: {error}", file=sys.stderr)
        return 1
    finally:
        if file_id and not args.keep_upload:
            try:
                json_request("DELETE", f"{gateway_root(args.base_url)}/v1/files/{quote(file_id)}", args.api_key, None, min(args.timeout, 30.0))
            except (GatewayRequestError, OSError, ValueError):
                pass


if __name__ == "__main__":
    raise SystemExit(main())
