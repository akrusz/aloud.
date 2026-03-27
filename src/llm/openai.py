"""OpenAI API provider."""

import asyncio
import os

from .base import BaseLLMProvider, Message, CompletionResult


class OpenAIProvider(BaseLLMProvider):
    """LLM provider using the OpenAI API."""

    def __init__(
        self,
        api_key: str | None = None,
        model: str = "gpt-5.4-mini",
        max_tokens: int = 300,
        base_url: str | None = None,
        env_key: str = "OPENAI_API_KEY",
        extra_body: dict | None = None,
    ):
        """Initialize OpenAI provider.

        Args:
            api_key: API key (defaults to env_key env var)
            model: Model to use
            max_tokens: Maximum tokens in response
            base_url: Optional base URL for OpenAI-compatible APIs (e.g. OpenRouter)
            env_key: Environment variable name for the API key
            extra_body: Extra parameters to pass in the request body
        """
        super().__init__(model=model, max_tokens=max_tokens)
        self.api_key = api_key or os.environ.get(env_key)
        self.base_url = base_url
        self.extra_body = extra_body

        if not self.api_key:
            raise ValueError(
                f"API key required. Set {env_key} environment variable "
                "or pass api_key parameter."
            )

        self._client = None
        self._client_loop: asyncio.AbstractEventLoop | None = None

    def _get_client(self):
        """Get or create OpenAI client.

        Recreates the client when the event loop changes (e.g. between
        successive ``asyncio.run()`` calls in the SocketIO handlers).
        """
        loop = asyncio.get_running_loop()
        if self._client is not None and self._client_loop is not loop:
            self._client = None
        if self._client is None:
            try:
                import openai
            except ImportError:
                raise ImportError(
                    "openai package not installed. Run: pip install openai"
                )

            import httpx as _httpx
            self._client = openai.AsyncOpenAI(
                api_key=self.api_key,
                base_url=self.base_url,
                timeout=_httpx.Timeout(60.0, connect=5.0),
            )
            self._client_loop = loop

        return self._client

    async def complete(
        self,
        messages: list[Message],
        system: str | None = None,
        max_tokens: int | None = None,
    ) -> CompletionResult:
        """Generate a completion using OpenAI API."""
        client = self._get_client()

        # Build messages list
        openai_messages = []

        if system:
            openai_messages.append({
                "role": "system",
                "content": system,
            })

        for msg in messages:
            openai_messages.append({
                "role": msg.role,
                "content": msg.content,
            })

        # Make API call
        kwargs = dict(
            model=self.model,
            messages=openai_messages,
            max_tokens=max_tokens or self.max_tokens,
        )
        if self.extra_body:
            kwargs["extra_body"] = self.extra_body
        response = await client.chat.completions.create(**kwargs)

        # Extract response
        choice = response.choices[0]
        text = choice.message.content or ""

        tokens_used = None
        if response.usage:
            tokens_used = response.usage.total_tokens

        return CompletionResult(
            text=text,
            finish_reason=choice.finish_reason,
            tokens_used=tokens_used,
        )
