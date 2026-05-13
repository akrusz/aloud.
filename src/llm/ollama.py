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
        model: str = "qwen3.5:4b",
        max_tokens: int = 300,
        timeout: float = 120.0,
        think: bool = False,
    ):
        """Initialize Ollama provider.

        Args:
            base_url: Ollama server URL
            model: Model to use (e.g., "qwen3.5:4b", "llama3.3", "mistral")
            max_tokens: Maximum tokens in response (Ollama uses num_predict)
            timeout: Request timeout in seconds
            think: Enable thinking/reasoning mode (slower, off by default)
        """
        super().__init__(model=model, max_tokens=max_tokens)
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.think = think
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
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(self.timeout, connect=5.0),
            )
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

        # Make request — disable thinking by default for faster responses
        response = await client.post(
            f"{self.base_url}/api/chat",
            json={
                "model": self.model,
                "messages": ollama_messages,
                "stream": False,
                "think": self.think,
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


# ---------------------------------------------------------------------------
# Provider registry — maps provider names to their configuration.
#
# Each entry contains:
#   module:        relative import path for the provider class
#   class_name:    class to import from that module
#   default_model: used when the caller doesn't specify a model
#   kwargs_fn:     callable(factory_args) -> dict of constructor kwargs
#
# kwargs_fn receives the full set of factory keyword arguments so each
# provider can pick the ones it needs and apply its own defaults.
# ---------------------------------------------------------------------------

PROVIDERS: dict[str, dict] = {
    "claude_proxy": {
        "module": ".claude_proxy",
        "class_name": "ClaudeProxyProvider",
        "default_model": "sonnet",
        "kwargs_fn": lambda a: {},
    },
    "anthropic": {
        "module": ".anthropic",
        "class_name": "AnthropicProvider",
        "default_model": "claude-sonnet-4-6",
        "kwargs_fn": lambda a: {
            "api_key": a["api_key"],
        },
    },
    "openai": {
        "module": ".openai",
        "class_name": "OpenAIProvider",
        "default_model": "gpt-5.4-mini",
        "kwargs_fn": lambda a: {
            "api_key": a["api_key"],
            "base_url": a["base_url"],
        },
    },
    "openrouter": {
        "module": ".openai",
        "class_name": "OpenAIProvider",
        "default_model": "deepseek/deepseek-v3.2",
        "kwargs_fn": lambda a: {
            "api_key": a["api_key"],
            "base_url": "https://openrouter.ai/api/v1",
            "env_key": "OPENROUTER_API_KEY",
        },
    },
    "venice": {
        "module": ".openai",
        "class_name": "OpenAIProvider",
        "default_model": "llama-3.3-70b",
        "kwargs_fn": lambda a: {
            "api_key": a["api_key"],
            "base_url": "https://api.venice.ai/api/v1",
            "env_key": "VENICE_API_KEY",
            "extra_body": {"venice_parameters": {"include_venice_system_prompt": False}},
        },
    },
    "groq": {
        "module": ".openai",
        "class_name": "OpenAIProvider",
        "default_model": "llama-3.3-70b-versatile",
        "kwargs_fn": lambda a: {
            "api_key": a["api_key"],
            "base_url": "https://api.groq.com/openai/v1",
            "env_key": "GROQ_API_KEY",
        },
    },
    "ollama": {
        "module": None,  # OllamaProvider is defined in this file
        "class_name": "OllamaProvider",
        "default_model": "qwen3.5:4b",
        "kwargs_fn": lambda a: {
            "base_url": a["ollama_url"] or "http://localhost:11434",
        },
    },
}


def create_llm_provider(
    provider: str,
    model: str | None = None,
    ollama_url: str | None = None,
    api_key: str | None = None,
    max_tokens: int = 300,
    base_url: str | None = None,
) -> BaseLLMProvider:
    """Factory function to create LLM provider.

    Args:
        provider: Provider name ("claude_proxy", "anthropic", "openai", "ollama", "openrouter", "venice", "groq")
        model: Model name (uses provider default if not specified)
        ollama_url: Ollama server URL (for ollama)
        api_key: API key (for anthropic/openai/openrouter)
        max_tokens: Maximum response tokens
        base_url: Custom base URL for OpenAI-compatible APIs

    Returns:
        LLM provider instance
    """
    import importlib

    cfg = PROVIDERS.get(provider)
    if cfg is None:
        raise ValueError(f"Unknown LLM provider: {provider}")

    # Resolve the provider class via lazy import (or from this module)
    if cfg["module"] is not None:
        mod = importlib.import_module(cfg["module"], package=__package__)
        cls = getattr(mod, cfg["class_name"])
    else:
        cls = globals()[cfg["class_name"]]

    # Build kwargs: start with provider-specific ones, then add common ones
    factory_args = {
        "ollama_url": ollama_url,
        "api_key": api_key,
        "base_url": base_url,
    }
    kwargs = cfg["kwargs_fn"](factory_args)
    kwargs["model"] = model or cfg["default_model"]
    kwargs["max_tokens"] = max_tokens

    return cls(**kwargs)
