"""Ollama provider for local LLM inference."""

import asyncio

import httpx

from .base import BaseLLMProvider, Message, CompletionResult


class OllamaProvider(BaseLLMProvider):
    """LLM provider using Ollama for local inference.

    Ollama supports various open models like llama3, mistral, etc.
    Great for fully private, offline operation.
    """

    def __init__(
        self,
        base_url: str = "http://localhost:11434",
        model: str = "llama3",
        max_tokens: int = 300,
        timeout: float = 120.0,
    ):
        """Initialize Ollama provider.

        Args:
            base_url: Ollama server URL
            model: Model to use (e.g., "llama3", "mistral", "llama3:8b")
            max_tokens: Maximum tokens in response (Ollama uses num_predict)
            timeout: Request timeout in seconds
        """
        super().__init__(model=model, max_tokens=max_tokens)
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._client: httpx.AsyncClient | None = None
        self._client_loop: asyncio.AbstractEventLoop | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create HTTP client.

        Recreates the client when the event loop changes (e.g. between
        successive ``asyncio.run()`` calls in the SocketIO handlers).
        """
        loop = asyncio.get_running_loop()
        if self._client is not None and self._client_loop is not loop:
            try:
                await self._client.aclose()
            except Exception:
                pass
            self._client = None
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.timeout)
            self._client_loop = loop
        return self._client

    async def complete(
        self,
        messages: list[Message],
        system: str | None = None,
        max_tokens: int | None = None,
    ) -> CompletionResult:
        """Generate a completion using Ollama."""
        client = await self._get_client()

        # Build messages list
        ollama_messages = []

        if system:
            ollama_messages.append({
                "role": "system",
                "content": system,
            })

        for msg in messages:
            ollama_messages.append({
                "role": msg.role,
                "content": msg.content,
            })

        # Make request
        response = await client.post(
            f"{self.base_url}/api/chat",
            json={
                "model": self.model,
                "messages": ollama_messages,
                "stream": False,
                "options": {
                    "num_predict": max_tokens or self.max_tokens,
                },
            },
        )
        response.raise_for_status()

        data = response.json()

        # Extract response
        text = data.get("message", {}).get("content", "")

        # Ollama provides some usage info
        tokens_used = None
        if "eval_count" in data:
            tokens_used = data.get("prompt_eval_count", 0) + data.get("eval_count", 0)

        return CompletionResult(
            text=text,
            finish_reason=data.get("done_reason"),
            tokens_used=tokens_used,
        )

    async def check_model_available(self) -> bool:
        """Check if the configured model is available.

        Returns:
            True if model is available
        """
        try:
            client = await self._get_client()
            response = await client.get(f"{self.base_url}/api/tags")
            response.raise_for_status()

            data = response.json()
            models = [m["name"] for m in data.get("models", [])]

            # Check for exact match or prefix match (e.g., "llama3" matches "llama3:latest")
            return any(
                m == self.model or m.startswith(f"{self.model}:")
                for m in models
            )
        except Exception:
            return False

    async def close(self) -> None:
        """Close the HTTP client."""
        if self._client:
            await self._client.aclose()
            self._client = None


def create_llm_provider(
    provider: str,
    model: str | None = None,
    proxy_url: str | None = None,
    ollama_url: str | None = None,
    api_key: str | None = None,
    max_tokens: int = 300,
    base_url: str | None = None,
) -> BaseLLMProvider:
    """Factory function to create LLM provider.

    Args:
        provider: Provider name ("claude_proxy", "anthropic", "openai", "ollama", "openrouter", "venice")
        model: Model name (uses provider default if not specified)
        proxy_url: CLIProxyAPI URL (for claude_proxy)
        ollama_url: Ollama server URL (for ollama)
        api_key: API key (for anthropic/openai/openrouter)
        max_tokens: Maximum response tokens
        base_url: Custom base URL for OpenAI-compatible APIs

    Returns:
        LLM provider instance
    """
    from .claude_proxy import ClaudeProxyProvider
    from .anthropic import AnthropicProvider
    from .openai import OpenAIProvider

    if provider == "claude_proxy":
        return ClaudeProxyProvider(
            proxy_url=proxy_url or "http://127.0.0.1:8317",
            model=model or "claude-sonnet-4-5-20250929",
            api_key=api_key,
            max_tokens=max_tokens,
        )
    elif provider == "anthropic":
        return AnthropicProvider(
            api_key=api_key,
            model=model or "claude-sonnet-4-5-20250929",
            max_tokens=max_tokens,
        )
    elif provider == "openai":
        return OpenAIProvider(
            api_key=api_key,
            model=model or "gpt-4o",
            max_tokens=max_tokens,
            base_url=base_url,
        )
    elif provider == "openrouter":
        return OpenAIProvider(
            api_key=api_key,
            model=model or "deepseek/deepseek-v3.2-20251201",
            max_tokens=max_tokens,
            base_url="https://openrouter.ai/api/v1",
            env_key="OPENROUTER_API_KEY",
        )
    elif provider == "venice":
        return OpenAIProvider(
            api_key=api_key,
            model=model or "llama-3.3-70b",
            max_tokens=max_tokens,
            base_url="https://api.venice.ai/api/v1",
            env_key="VENICE_API_KEY",
            extra_body={"venice_parameters": {"include_venice_system_prompt": False}},
        )
    elif provider == "ollama":
        return OllamaProvider(
            base_url=ollama_url or "http://localhost:11434",
            model=model or "llama3",
            max_tokens=max_tokens,
        )
    else:
        raise ValueError(f"Unknown LLM provider: {provider}")
