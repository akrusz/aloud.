"""Claude provider using CLIProxyAPI for Pro/Max subscription routing.

CLIProxyAPI exposes your Claude subscription as an API endpoint.
Uses the native Anthropic Messages format (/v1/messages) so that
prompt caching via cache_control passes through to Anthropic.
https://github.com/router-for-me/CLIProxyAPI
"""

import logging

import httpx

from .base import BaseLLMProvider, Message, CompletionResult

logger = logging.getLogger(__name__)

# Fixed key for the localhost proxy. Hardcoded rather than read from
# config.llm.api_key so switching providers can't poison this value.
PROXY_API_KEY = "glooow"


class ClaudeProxyProvider(BaseLLMProvider):
    """LLM provider using CLIProxyAPI to route through a Claude subscription.

    Uses the native Anthropic /v1/messages endpoint (not the OpenAI-compatible
    one) so we can pass cache_control on the system prompt. CLIProxyAPI
    forwards these requests to Anthropic unchanged.
    """

    def __init__(
        self,
        proxy_url: str = "http://127.0.0.1:8317",
        model: str = "claude-sonnet-4-6",
        max_tokens: int = 300,
        timeout: float = 60.0,
    ):
        """Initialize Claude proxy provider.

        Args:
            proxy_url: URL of the CLIProxyAPI server
            model: Model to use
            max_tokens: Maximum tokens in response
            timeout: Request timeout in seconds
        """
        super().__init__(model=model, max_tokens=max_tokens)
        self.proxy_url = proxy_url.rstrip("/")
        self.timeout = timeout

    def _make_client(self) -> httpx.AsyncClient:
        """Create a new HTTP client."""
        headers = {
            "Content-Type": "application/json",
            "X-Api-Key": PROXY_API_KEY,
        }
        return httpx.AsyncClient(
            timeout=httpx.Timeout(self.timeout, connect=5.0),
            headers=headers,
        )

    async def complete(
        self,
        messages: list[Message],
        system: str | None = None,
        max_tokens: int | None = None,
    ) -> CompletionResult:
        """Generate a completion using CLIProxyAPI's native Anthropic endpoint.

        Uses /v1/messages with cache_control on the system prompt so the
        large facilitation prompt is cached across exchanges within a session.
        """
        # Build Anthropic-native messages (user/assistant only)
        anthropic_messages = []
        for msg in messages:
            if msg.role != "system":
                anthropic_messages.append({
                    "role": msg.role,
                    "content": msg.content,
                })

        # System prompt with cache_control — after the first exchange,
        # subsequent requests get a cache hit (~90% fewer input tokens).
        system_param = None
        if system:
            system_param = [{
                "type": "text",
                "text": system,
                "cache_control": {"type": "ephemeral"},
            }]

        body = {
            "model": self.model,
            "max_tokens": max_tokens or self.max_tokens,
            "messages": anthropic_messages,
        }
        if system_param:
            body["system"] = system_param

        # Make request to proxy's native Anthropic endpoint
        async with self._make_client() as client:
            response = await client.post(
                f"{self.proxy_url}/v1/messages",
                json=body,
            )
            response.raise_for_status()

            data = response.json()

        # Extract response (Anthropic format)
        text = ""
        if data.get("content"):
            for block in data["content"]:
                if block.get("type") == "text":
                    text = block.get("text", "")
                    break

        finish_reason = data.get("stop_reason")

        tokens_used = None
        usage = data.get("usage", {})
        if usage:
            input_tokens = usage.get("input_tokens", 0)
            output_tokens = usage.get("output_tokens", 0)
            tokens_used = input_tokens + output_tokens

            cache_read = usage.get("cache_read_input_tokens", 0)
            cache_create = usage.get("cache_creation_input_tokens", 0)
            if cache_read or cache_create:
                logger.debug("Cache read=%d create=%d input=%d output=%d",
                             cache_read, cache_create, input_tokens, output_tokens)

        return CompletionResult(
            text=text,
            finish_reason=finish_reason,
            tokens_used=tokens_used,
        )
