"""Anthropic API provider for Claude."""

import os

from .base import BaseLLMProvider, Message, CompletionResult


class AnthropicProvider(BaseLLMProvider):
    """LLM provider using the Anthropic API directly.

    Useful for:
    - Using Haiku 4.5 for cost efficiency ($1/$5 per MTok)
    - When the local `claude` CLI subscription path isn't available
    - Production deployments
    """

    def __init__(
        self,
        api_key: str | None = None,
        model: str = "claude-sonnet-4-6",
        max_tokens: int = 300,
    ):
        """Initialize Anthropic provider.

        Args:
            api_key: Anthropic API key (defaults to ANTHROPIC_API_KEY env var)
            model: Model to use
            max_tokens: Maximum tokens in response
        """
        super().__init__(model=model, max_tokens=max_tokens)
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")

        if not self.api_key:
            raise ValueError(
                "Anthropic API key required. Set ANTHROPIC_API_KEY environment variable "
                "or pass api_key parameter."
            )

        self._client = None

    def _get_client(self):
        """Get or create Anthropic client."""
        if self._client is None:
            try:
                import anthropic
            except ImportError:
                raise ImportError(
                    "anthropic package not installed. Run: pip install anthropic"
                )

            import httpx as _httpx
            self._client = anthropic.AsyncAnthropic(
                api_key=self.api_key,
                timeout=_httpx.Timeout(60.0, connect=5.0),
            )

        return self._client

    async def complete(
        self,
        messages: list[Message],
        system: str | None = None,
        max_tokens: int | None = None,
    ) -> CompletionResult:
        """Generate a completion using Anthropic API."""
        client = self._get_client()

        # Convert messages to Anthropic format
        anthropic_messages = []
        for msg in messages:
            if msg.role != "system":  # System is passed separately
                anthropic_messages.append({
                    "role": msg.role,
                    "content": msg.content,
                })

        # Use cache_control on the system prompt so repeated calls within a
        # session get ~90% off input tokens (huge saving for Pro plan users).
        system_param = ""
        if system:
            system_param = [{
                "type": "text",
                "text": system,
                "cache_control": {"type": "ephemeral"},
            }]

        # Make API call
        response = await client.messages.create(
            model=self.model,
            max_tokens=max_tokens or self.max_tokens,
            system=system_param,
            messages=anthropic_messages,
        )

        # Extract response
        text = response.content[0].text if response.content else ""

        tokens_used = None
        input_tokens = output_tokens = None
        cache_read = cache_create = None
        if response.usage:
            input_tokens = response.usage.input_tokens
            output_tokens = response.usage.output_tokens
            tokens_used = input_tokens + output_tokens
            # Present when prompt caching is in play (cache_control above).
            cache_read = getattr(response.usage, "cache_read_input_tokens", None)
            cache_create = getattr(response.usage, "cache_creation_input_tokens", None)

        return CompletionResult(
            text=text,
            finish_reason=response.stop_reason,
            tokens_used=tokens_used,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_read_tokens=cache_read,
            cache_creation_tokens=cache_create,
        )
