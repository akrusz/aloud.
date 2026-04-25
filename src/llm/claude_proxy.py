"""Claude provider using the local `claude` CLI for subscription routing.

Shells out to `claude -p` (headless mode) so the user's Pro/Max subscription
quota is used rather than API credits. Each completion spawns a fresh
subprocess, passes the system prompt via --system-prompt (which fully
replaces Claude Code's default), and parses the JSON response.

The class name and module name are kept from the previous CLIProxyAPI-based
implementation so existing user configs with `provider: claude_proxy` keep
working without migration.
"""

import asyncio
import json
import logging
import shutil

from .base import BaseLLMProvider, Message, CompletionResult

logger = logging.getLogger(__name__)


class ClaudeProxyProvider(BaseLLMProvider):
    """LLM provider that shells out to the local `claude` CLI."""

    def __init__(
        self,
        model: str = "sonnet",
        max_tokens: int = 300,
        timeout: float = 90.0,
    ):
        super().__init__(model=model, max_tokens=max_tokens)
        self.timeout = timeout

    async def complete(
        self,
        messages: list[Message],
        system: str | None = None,
        max_tokens: int | None = None,
    ) -> CompletionResult:
        binary = shutil.which("claude")
        if not binary:
            raise RuntimeError(
                "claude CLI not found on PATH. Install Claude Code to use "
                "the Anthropic Subscription provider."
            )

        prompt = _format_history(messages)

        cmd = [
            binary,
            "-p",
            "--tools", "",
            "--no-session-persistence",
            "--disable-slash-commands",
            "--output-format", "json",
            "--model", self.model,
        ]
        if system:
            cmd.extend(["--system-prompt", system])
        cmd.append(prompt)

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=self.timeout
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise

        if proc.returncode != 0:
            err = stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(
                f"claude CLI failed (exit {proc.returncode}): {err}"
            )

        try:
            data = json.loads(stdout)
        except json.JSONDecodeError as e:
            raise RuntimeError(f"claude CLI returned invalid JSON: {e}") from e

        if data.get("is_error"):
            raise RuntimeError(
                f"claude CLI error: {data.get('result') or data.get('api_error_status') or 'unknown'}"
            )

        text = data.get("result", "")
        finish_reason = data.get("stop_reason")

        tokens_used = None
        usage = data.get("usage") or {}
        if usage:
            input_tokens = usage.get("input_tokens", 0)
            output_tokens = usage.get("output_tokens", 0)
            tokens_used = input_tokens + output_tokens

            cache_read = usage.get("cache_read_input_tokens", 0)
            cache_create = usage.get("cache_creation_input_tokens", 0)
            if cache_read or cache_create:
                logger.debug(
                    "Cache read=%d create=%d input=%d output=%d",
                    cache_read, cache_create, input_tokens, output_tokens,
                )

        return CompletionResult(
            text=text,
            finish_reason=finish_reason,
            tokens_used=tokens_used,
        )


def _format_history(messages: list[Message]) -> str:
    """Encode multi-turn history as a single prompt string.

    The claude CLI takes one prompt argument, so prior turns are passed
    inline as a User:/Assistant: transcript. System messages are skipped
    here — the system prompt is set via --system-prompt instead.
    """
    convo = [m for m in messages if m.role != "system"]
    if not convo:
        return ""
    if len(convo) == 1 and convo[0].role == "user":
        return convo[0].content

    lines = []
    for msg in convo:
        role = "User" if msg.role == "user" else "Assistant"
        lines.append(f"{role}: {msg.content}")
    return "\n\n".join(lines)
