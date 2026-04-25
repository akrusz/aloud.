"""Provider and model-related HTTP route handlers."""

import logging
import os
import platform
import shutil
import subprocess
import time

import httpx
from flask import Flask, request, jsonify, Response

from ..config import DEFAULT_OLLAMA_TIERS

logger = logging.getLogger(__name__)


# ---- System hardware detection ----

def _get_system_ram_gb() -> int | None:
    """Return total system RAM in whole GB, or None if unknown."""
    try:
        if platform.system() == "Darwin":
            out = subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True)
            return int(out.strip()) // (1024 ** 3)
        # Linux / other POSIX
        pages = os.sysconf("SC_PHYS_PAGES")
        page_size = os.sysconf("SC_PAGE_SIZE")
        if pages > 0 and page_size > 0:
            return (pages * page_size) // (1024 ** 3)
    except Exception as e:
        logger.debug("Could not detect system RAM: %s", e)
    return None


def _has_fast_gpu(min_vram_gb: int = 20) -> bool:
    """Check if the system has a GPU with enough VRAM for large models.

    On macOS (Apple Silicon), unified memory is always fast — returns True.
    On other platforms, checks for an NVIDIA GPU via nvidia-smi.
    """
    if platform.system() == "Darwin":
        return True
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.total",
             "--format=csv,noheader,nounits"],
            text=True, timeout=3,
        )
        for line in out.strip().splitlines():
            if int(line.strip()) >= min_vram_gb * 1024:
                return True
    except Exception:
        pass
    return False


def _recommended_ollama_model(ram_gb: int | None, tiers: list[dict]) -> dict:
    """Pick the best Ollama model tier for the given RAM.

    Tiers with ``auto_recommend: False`` (e.g. dense models that are too slow
    even on machines with enough RAM) are visible in the UI but skipped here.
    """
    if ram_gb is None:
        return tiers[-1]  # default to smallest
    for tier in tiers:
        if tier.get("auto_recommend", True) and ram_gb >= tier["min_gb"]:
            return tier
    return tiers[-1]


def _is_ollama_installed(app) -> bool:
    """Check if Ollama is available (CLI on PATH or server reachable)."""
    if shutil.which("ollama"):
        return True
    # Ollama.app on macOS runs the server without putting the CLI on PATH
    ollama_url = getattr(app, "meditation_config", None)
    if ollama_url:
        ollama_url = ollama_url.llm.ollama_url or "http://localhost:11434"
    else:
        ollama_url = "http://localhost:11434"
    try:
        resp = httpx.get(f"{ollama_url.rstrip('/')}/", timeout=1.0)
        return resp.status_code == 200
    except Exception:
        return False


def find_claude_cli() -> str | None:
    """Find the `claude` CLI binary, searching beyond the app bundle's limited PATH."""
    binary = shutil.which("claude")
    if binary:
        return binary
    # macOS app bundles have a minimal PATH — ask the user's login shell
    try:
        result = subprocess.run(
            ["/bin/zsh", "-lc", "which claude"],
            capture_output=True, text=True, timeout=5,
        )
        path = result.stdout.strip()
        if result.returncode == 0 and path and os.path.isfile(path):
            return path
    except Exception as e:
        logger.debug("Shell lookup for claude CLI failed: %s", e)
    return None


# ---- Dynamic model fetching ----

_models_cache: dict[str, tuple[float, list]] = {}
_MODELS_CACHE_TTL = 300  # 5 minutes


def _fetch_provider_models(provider: str, config) -> list[dict]:
    """Fetch models from a provider API, with caching. Returns [{value, label}]."""
    now = time.time()
    cached = _models_cache.get(provider)
    if cached and now - cached[0] < _MODELS_CACHE_TTL:
        return cached[1]

    try:
        models = _do_fetch_models(provider, config)
    except Exception as e:
        logger.debug("Failed to fetch models for %s: %s", provider, e)
        return []

    if models:
        _models_cache[provider] = (now, models)
    return models


def _do_fetch_models(provider: str, config) -> list[dict]:
    """Provider-specific model fetching."""
    if provider == "openai":
        return _fetch_openai_models()
    elif provider == "anthropic":
        return _fetch_anthropic_models()
    elif provider == "claude_proxy":
        return _fetch_claude_proxy_models(config)
    elif provider == "openrouter":
        return _fetch_openrouter_models()
    elif provider == "venice":
        return _fetch_venice_models()
    # ollama is already dynamic in /api/providers
    return []


def _fetch_openai_models() -> list[dict]:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return []
    resp = httpx.get(
        "https://api.openai.com/v1/models",
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=5,
    )
    resp.raise_for_status()
    raw = resp.json().get("data", [])

    # Filter to chat models only
    chat_prefixes = ("gpt-5", "gpt-4", "gpt-3.5", "o1", "o3", "o4", "chatgpt")
    exclude_terms = ("realtime", "audio", "search", "transcription",
                     "embedding", "moderation", "tts", "whisper", "dall-e",
                     "instruct")
    models = []
    for m in raw:
        mid = m["id"]
        if not any(mid.startswith(p) for p in chat_prefixes):
            continue
        if any(t in mid for t in exclude_terms):
            continue
        models.append({"value": mid, "label": _openai_label(mid), "created": m.get("created", 0)})

    # Sort newest first, deduplicate
    models.sort(key=lambda x: x["created"], reverse=True)
    return [{"value": m["value"], "label": m["label"]} for m in models]


def _openai_label(model_id: str) -> str:
    """Turn an OpenAI model ID into a readable label."""
    # gpt-4.1-mini -> GPT-4.1 Mini, o3-mini -> o3 Mini
    parts = model_id.split("-")
    if parts[0].lower() == "gpt":
        parts[0] = "GPT"
    if parts[0].lower() == "chatgpt":
        parts[0] = "ChatGPT"
    return " ".join(
        p.capitalize() if p.isalpha() and p.lower() not in ("gpt", "chatgpt") else p
        for p in parts
    ).replace("GPT ", "GPT-").replace("ChatGPT ", "ChatGPT-")


def _fetch_anthropic_models() -> list[dict]:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return []
    resp = httpx.get(
        "https://api.anthropic.com/v1/models",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
        timeout=5,
    )
    resp.raise_for_status()
    raw = resp.json().get("data", [])
    models = []
    for m in raw:
        mid = m.get("id", "")
        label = m.get("display_name", mid)
        created = m.get("created_at", "")
        models.append({"value": mid, "label": label, "sort": created})

    models.sort(key=lambda x: x["sort"], reverse=True)
    return [{"value": m["value"], "label": m["label"]} for m in models]


def _fetch_claude_proxy_models(config) -> list[dict]:
    """Static model list for the Claude subscription provider.

    Uses the `claude` CLI's stable model aliases — these always resolve
    to the latest version of each tier, so this list never goes stale
    even when Anthropic ships new models. Includes Opus 3 as a pinned
    legacy option since some users specifically prefer it.
    """
    return [
        {"value": "opus", "label": "Opus (latest)"},
        {"value": "sonnet", "label": "Sonnet (latest)"},
        {"value": "haiku", "label": "Haiku (latest)"},
        {"value": "claude-3-opus-20240229", "label": "Opus 3"},
    ]


def _fetch_openrouter_models() -> list[dict]:
    # OpenRouter's models endpoint is public (no auth needed)
    resp = httpx.get("https://openrouter.ai/api/v1/models", timeout=8)
    resp.raise_for_status()
    raw = resp.json().get("data", [])

    # Filter to text generation models from well-known providers
    keep_orgs = {"anthropic", "openai", "google", "meta-llama",
                 "deepseek", "mistralai", "qwen", "moonshotai"}
    models = []
    for m in raw:
        mid = m.get("id", "")
        org = mid.split("/")[0] if "/" in mid else ""
        if org not in keep_orgs:
            continue
        # Skip free/extended variants
        if mid.endswith(":free") or mid.endswith(":extended"):
            continue
        label = m.get("name", mid)
        ctx = m.get("context_length", 0)
        models.append({"value": mid, "label": label, "ctx": ctx})

    # Sort by context length (proxy for recency/capability)
    models.sort(key=lambda x: x["ctx"], reverse=True)
    return [{"value": m["value"], "label": m["label"]} for m in models[:30]]


def _fetch_venice_models() -> list[dict]:
    api_key = os.environ.get("VENICE_API_KEY")
    if not api_key:
        return []
    resp = httpx.get(
        "https://api.venice.ai/api/v1/models",
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=5,
    )
    resp.raise_for_status()
    raw = resp.json().get("data", [])
    models = []
    for m in raw:
        mid = m.get("id", "")
        # Venice includes image/code models — filter to text
        mtype = m.get("type", "")
        if mtype and mtype not in ("text", "chat", ""):
            continue
        label = m.get("name", "") or mid
        models.append({"value": mid, "label": label})

    return models


# ---- Route registration ----

def register_provider_routes(app: Flask) -> None:
    """Register provider, model, and Ollama routes."""

    @app.route("/api/system-info")
    def api_system_info():
        """Return system platform info and tool availability."""
        system = platform.system()
        has_homebrew = shutil.which("brew") is not None
        claude_binary = find_claude_cli()

        return jsonify({
            "platform": system.lower(),
            "has_homebrew": has_homebrew,
            "tools": {
                "claude_cli": {
                    "installed": claude_binary is not None,
                    "path": claude_binary,
                },
                "ollama": {
                    "installed": _is_ollama_installed(app) and not getattr(app, "no_ollama", False),
                    "path": None if getattr(app, "no_ollama", False) else shutil.which("ollama"),
                },
            },
        })

    @app.route("/api/providers")
    def api_providers():
        """Return provider availability based on env vars / claude CLI presence."""
        from concurrent.futures import ThreadPoolExecutor

        results = {}

        refresh = ' <a href="#" onclick="refreshProviders(); return false">Refresh</a>'
        claude_binary = find_claude_cli()

        # claude CLI presence is a sync check — Ollama probe runs in parallel below.
        if claude_binary:
            results["claude_proxy"] = {"available": True, "installed": True, "hint": ""}
        else:
            results["claude_proxy"] = {
                "available": False, "installed": False,
                "hint": (
                    "Claude Code CLI is not installed. "
                    "<a href='https://claude.com/product/claude-code' target='_blank'>"
                    "Install Claude Code</a>, then run <code>claude</code> once to log in "
                    "with your Pro/Max subscription." + refresh
                ),
            }

        def _check_ollama():
            ollama_url = app.meditation_config.llm.ollama_url or "http://localhost:11434"
            try:
                resp = httpx.get(f"{ollama_url.rstrip('/')}/api/tags", timeout=2.0)
                resp.raise_for_status()
                return resp.json().get("models", [])
            except Exception:
                return None  # not running

        with ThreadPoolExecutor(max_workers=1) as pool:
            ollama_future = pool.submit(_check_ollama)

        # API key providers — instant, no network
        results["anthropic"] = {
            "available": bool(os.environ.get("ANTHROPIC_API_KEY")),
            "hint": (
                "Add your API key in <a href='/settings'>Settings</a> "
                "or set <code>ANTHROPIC_API_KEY</code> in your environment."
            ),
        }

        results["openai"] = {
            "available": bool(os.environ.get("OPENAI_API_KEY")),
            "hint": (
                "Add your API key in <a href='/settings'>Settings</a> "
                "or set <code>OPENAI_API_KEY</code> in your environment."
            ),
        }

        results["openrouter"] = {
            "available": bool(os.environ.get("OPENROUTER_API_KEY")),
            "hint": (
                "Add your API key in <a href='/settings'>Settings</a> "
                "or set <code>OPENROUTER_API_KEY</code> in your environment."
            ),
        }

        results["venice"] = {
            "available": bool(os.environ.get("VENICE_API_KEY")),
            "hint": (
                "Add your API key in <a href='/settings'>Settings</a> "
                "or set <code>VENICE_API_KEY</code> in your environment."
            ),
        }

        # ollama — process the result from the parallel probe
        tiers = app.meditation_config.llm.ollama_tiers or DEFAULT_OLLAMA_TIERS
        ram_gb = _get_system_ram_gb()
        rec = _recommended_ollama_model(ram_gb, tiers)
        has_gpu = _has_fast_gpu()
        tier_list = []
        for t in tiers:
            note = t.get("note", "")
            if not has_gpu and t["min_gb"] >= 24:
                note += ". May be slow with your current GPU" if note else "May be slow with your current GPU"
            tier_list.append({
                "model": t["model"], "label": t["label"],
                "download": t["download"], "ram": t["ram"], "note": note,
                "min_gb": t["min_gb"],
                "fits": ram_gb is not None and ram_gb >= t["min_gb"],
            })
        rec_info = {
            "ram_gb": ram_gb,
            "recommended_model": rec["model"],
            "recommended_label": rec["label"],
            "tiers": tier_list,
        }

        raw_models = ollama_future.result()
        if raw_models is not None:
            models = [m["name"] for m in raw_models]
            model_sizes = {}
            for m in raw_models:
                size_bytes = m.get("size", 0)
                if size_bytes > 0:
                    gb = size_bytes / (1024 ** 3)
                    model_sizes[m["name"]] = (
                        f"{gb:.1f}GB" if gb >= 1 else f"{size_bytes / (1024**2):.0f}MB"
                    )
            for t in rec_info["tiers"]:
                tier_base = t["model"].split(":")[0]
                t["installed"] = any(
                    n.split(":")[0] == tier_base and t["model"].split(":")[-1] in n
                    for n in models
                )

            if models:
                results["ollama"] = {
                    "available": True, "models": models, "hint": "",
                    "model_sizes": model_sizes,
                    "recommendation": rec_info,
                }
            else:
                results["ollama"] = {
                    "available": False, "models": [],
                    "hint": (
                        "Ollama is running but has no models. "
                        "Download one below, or run: "
                        f"<code>ollama pull {rec['model']}</code>" + refresh
                    ),
                    "recommendation": rec_info,
                }
        else:
            results["ollama"] = {
                "available": False, "models": [],
                "hint": (
                    "Ollama is not running. "
                    "<a href='/settings'>Install from Settings</a> or visit "
                    "<a href='https://ollama.ai' target='_blank'>ollama.ai</a>, "
                    "then:" + refresh
                ),
                "recommendation": rec_info,
            }

        # --no-ollama: make Ollama appear not installed/running
        if getattr(app, "no_ollama", False) and "ollama" in results:
            results["ollama"]["available"] = False
            results["ollama"]["models"] = []
            results["ollama"]["hint"] = (
                "Ollama is not running. "
                "<a href='/settings'>Install from Settings</a> or visit "
                "<a href='https://ollama.ai' target='_blank'>ollama.ai</a>, "
                "then:" + refresh
            )

        # --no-providers: force all providers unavailable
        if getattr(app, "no_providers", False):
            for key in results:
                results[key]["available"] = False
                if "models" in results[key]:
                    results[key]["models"] = []

        return jsonify(results)

    @app.route("/api/ollama/pull", methods=["POST"])
    def api_ollama_pull():
        """Stream an Ollama model pull, proxying progress from Ollama's API."""
        import json as _json

        data = request.get_json(silent=True) or {}
        model = data.get("model", "").strip()
        if not model:
            return jsonify({"error": "model is required"}), 400

        ollama_url = (
            app.meditation_config.llm.ollama_url or "http://localhost:11434"
        )

        def generate():
            try:
                with httpx.stream(
                    "POST",
                    f"{ollama_url.rstrip('/')}/api/pull",
                    json={"model": model, "stream": True},
                    timeout=httpx.Timeout(10.0, read=600.0),
                ) as resp:
                    resp.raise_for_status()
                    for line in resp.iter_lines():
                        if not line:
                            continue
                        obj = _json.loads(line)
                        # Forward a simplified progress object
                        out = {"status": obj.get("status", "")}
                        if "total" in obj and "completed" in obj:
                            out["total"] = obj["total"]
                            out["completed"] = obj["completed"]
                        yield _json.dumps(out) + "\n"
            except httpx.HTTPStatusError as exc:
                yield _json.dumps({
                    "status": "error",
                    "error": f"Ollama returned {exc.response.status_code}",
                }) + "\n"
            except Exception as exc:
                yield _json.dumps({
                    "status": "error",
                    "error": str(exc),
                }) + "\n"

        return Response(
            generate(),
            mimetype="application/x-ndjson",
            headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
        )

    @app.route("/api/ollama/delete", methods=["POST"])
    def api_ollama_delete():
        """Delete a pulled Ollama model."""
        data = request.get_json(silent=True) or {}
        model = data.get("model", "").strip()
        if not model:
            return jsonify({"error": "model is required"}), 400

        ollama_url = (
            app.meditation_config.llm.ollama_url or "http://localhost:11434"
        )
        try:
            resp = httpx.delete(
                f"{ollama_url.rstrip('/')}/api/delete",
                json={"model": model},
                timeout=30.0,
            )
            resp.raise_for_status()
            return jsonify({"ok": True})
        except httpx.HTTPStatusError as exc:
            return jsonify({"error": f"Ollama returned {exc.response.status_code}"}), 502
        except Exception as exc:
            return jsonify({"error": str(exc)}), 502

    @app.route("/api/models/<provider>")
    def api_models(provider):
        """Fetch available models from a provider's API."""
        models = _fetch_provider_models(provider, app.meditation_config)
        return jsonify(models)
