"""Thin LLM proxy routes for the TS browser/Capacitor UI.

Anthropic's API rejects browser-origin requests (no CORS), and we don't
want API keys living in the browser anyway. This proxy lets the TS UI
call /api/llm/anthropic/messages with the same body shape as the
upstream API; the Flask side substitutes the server-side key from the
existing config and forwards.

Streaming is intentionally not supported yet — the TS client uses
non-streaming requests. Add it here when the UI starts streaming.
"""

import logging
import os

import httpx
from flask import Flask, Response, request

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


def _error(status: int, message: str) -> Response:
    return Response(
        f'{{"error": "{message}"}}',
        status=status,
        content_type="application/json",
    )
