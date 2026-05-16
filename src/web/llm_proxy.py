"""Thin LLM proxy routes for the TS browser/Capacitor UI.

Anthropic's API rejects browser-origin requests (no CORS), and we don't
want API keys living in the browser anyway. This proxy lets the TS UI
call /api/llm/anthropic/messages with the same body shape as the
upstream API; the Flask side substitutes the server-side key from the
existing config and forwards.

claude_proxy is a subprocess-based provider that the browser can't run
directly. /api/llm/claude_proxy/complete bridges that — accepts a
provider-neutral JSON body, runs ClaudeProxyProvider on the Python
side, returns a CompletionResult-shaped JSON response. Desktop-only by
nature (needs the `claude` CLI installed and authenticated).

Streaming is intentionally not supported yet — the TS client uses
non-streaming requests. Add it here when the UI starts streaming.
"""

import asyncio
import logging
import os

import httpx
from flask import Flask, Response, jsonify, request

logger = logging.getLogger(__name__)

ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_API_VERSION = "2023-06-01"
REQUEST_TIMEOUT_SEC = 60.0
MAX_REQUEST_BYTES = 1 * 1024 * 1024  # 1 MiB cap on prompt+history payload


def register_llm_proxy_routes(app: Flask) -> None:
    """Register thin proxy routes for browser-side LLM access."""

    @app.route("/api/llm/anthropic/messages", methods=["POST"])
    def anthropic_proxy() -> Response:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            return _error(
                503,
                "Server has no ANTHROPIC_API_KEY configured. "
                "Set it via the Settings page or the environment.",
            )

        body = request.get_data(cache=False)
        if not body:
            return _error(400, "Empty request body.")
        if len(body) > MAX_REQUEST_BYTES:
            return _error(413, "Request body too large.")

        try:
            upstream = httpx.post(
                ANTHROPIC_API_URL,
                content=body,
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": ANTHROPIC_API_VERSION,
                    "content-type": "application/json",
                },
                timeout=REQUEST_TIMEOUT_SEC,
            )
        except httpx.TimeoutException:
            return _error(504, "Upstream Anthropic request timed out.")
        except httpx.HTTPError as e:
            logger.warning("Anthropic proxy upstream error: %s", e)
            return _error(502, f"Upstream error: {e}")

        # Pass through status and body unchanged. Anthropic's error responses
        # are JSON with useful detail — preserving them helps client-side
        # debugging instead of masking everything as a generic 5xx.
        return Response(
            upstream.content,
            status=upstream.status_code,
            content_type=upstream.headers.get("content-type", "application/json"),
        )


    @app.route("/api/llm/claude_proxy/complete", methods=["POST"])
    def claude_proxy_complete() -> Response:
        """Run a single ClaudeProxyProvider.complete() and return its
        result as JSON. The TS UI uses this when the user picks the
        Claude Subscription provider — the browser can't shell out to
        the `claude` CLI, so Flask does it on its behalf.
        """
        data = request.get_json(silent=True) or {}
        messages_raw = data.get("messages") or []
        system = data.get("system")
        model = data.get("model") or "sonnet"
        max_tokens = int(data.get("max_tokens") or 400)

        # Validate message shape so a malformed body fails clean rather
        # than crashing inside the subprocess.
        if not isinstance(messages_raw, list):
            return _json_error(400, "messages must be a list")
        msgs = []
        try:
            from ..llm.base import Message
            for m in messages_raw:
                if not isinstance(m, dict):
                    return _json_error(400, "each message must be an object")
                role = m.get("role")
                content = m.get("content")
                if role not in ("user", "assistant", "system") or not isinstance(content, str):
                    return _json_error(400, "message missing valid role/content")
                msgs.append(Message(role=role, content=content))
        except Exception as e:
            logger.warning("claude_proxy proxy bad request: %s", e)
            return _json_error(400, f"bad request: {e}")

        try:
            from ..llm.ollama import create_llm_provider
            provider = create_llm_provider(
                provider="claude_proxy",
                model=model,
                max_tokens=max_tokens,
            )
            result = asyncio.run(provider.complete(messages=msgs, system=system))
        except RuntimeError as e:
            # ClaudeProxyProvider raises a friendly RuntimeError when the
            # `claude` binary isn't on PATH — surface that to the client.
            logger.warning("claude_proxy unavailable: %s", e)
            return _json_error(503, str(e))
        except Exception as e:
            logger.exception("claude_proxy failed")
            return _json_error(500, str(e))

        return jsonify({
            "text": result.text,
            "finish_reason": result.finish_reason,
            "tokens_used": result.tokens_used,
        })


def _error(status: int, message: str) -> Response:
    return Response(
        f'{{"error": "{message}"}}',
        status=status,
        content_type="application/json",
    )


def _json_error(status: int, message: str) -> tuple:
    return jsonify({"error": message}), status
