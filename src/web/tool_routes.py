"""Tool installation HTTP route handlers."""

import logging
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path

import httpx
from flask import Flask, jsonify, Response

logger = logging.getLogger(__name__)


def register_tool_routes(app: Flask) -> None:
    """Register tool installation routes."""

    @app.route("/api/ollama/restart", methods=["POST"])
    def api_ollama_restart():
        """Stop and restart the running Ollama daemon, then wait for it to come back.

        Detects whether Ollama is running as the macOS .app or as a headless
        `ollama serve` daemon, and respawns it the same way. Falls back to
        whichever is available if detection is inconclusive.
        """
        import json as _json

        ollama_url = (
            app.meditation_config.llm.ollama_url or "http://localhost:11434"
        )
        version_url = f"{ollama_url.rstrip('/')}/api/version"

        def _ping() -> str | None:
            try:
                resp = httpx.get(version_url, timeout=0.5)
                if resp.status_code == 200:
                    return resp.json().get("version", "")
            except Exception:
                return None
            return None

        def _detect_running_method() -> str:
            """Return 'app' (Ollama.app), 'serve' (headless), or 'unknown'."""
            try:
                result = subprocess.run(
                    ["ps", "-Ao", "command="],
                    capture_output=True, text=True, timeout=5,
                )
            except Exception as exc:
                logger.debug("ps lookup failed: %s", exc)
                return "unknown"
            for line in result.stdout.splitlines():
                line = line.strip()
                if not line:
                    continue
                if "Ollama.app/" in line or "/Ollama.app" in line:
                    return "app"
                # Match `ollama serve` invocations regardless of binary path
                first = line.split(None, 1)[0]
                if first.endswith("/ollama") or first == "ollama":
                    if " serve" in line or line.endswith(" serve"):
                        return "serve"
                    # A bare `ollama` process is almost always the daemon too
                    return "serve"
            return "unknown"

        def generate():
            try:
                # Capture pre-shutdown state so we can restart the same way,
                # and so we can detect "version didn't change" after restart.
                running_method = _detect_running_method()
                pre_version = _ping()
                logger.debug(
                    "Detected Ollama running as %s, version %s",
                    running_method, pre_version,
                )

                yield _json.dumps({"status": "Stopping Ollama..."}) + "\n"

                # Graceful stop. -i for case-insensitive (matches both `ollama`
                # daemon and `Ollama` from Ollama.app); -x for exact name.
                try:
                    subprocess.run(
                        ["pkill", "-i", "-x", "ollama"],
                        capture_output=True, timeout=5,
                    )
                except Exception as exc:
                    logger.debug("pkill failed: %s", exc)

                # Wait up to 10s for the server to actually shut down. If we
                # can't confirm shutdown, bail before "starting" — otherwise
                # the version-poll below would see the still-running old
                # daemon and report a false "done".
                shut_down = False
                for _ in range(20):
                    if _ping() is None:
                        shut_down = True
                        break
                    time.sleep(0.5)

                if not shut_down:
                    yield _json.dumps({
                        "status": "error",
                        "error": "Could not stop the running Ollama process. It may need to be killed manually.",
                    }) + "\n"
                    return

                yield _json.dumps({"status": "Starting Ollama..."}) + "\n"

                ollama_bin = shutil.which("ollama")
                has_app = (
                    platform.system() == "Darwin"
                    and Path("/Applications/Ollama.app").is_dir()
                )

                # Build an ordered list of restart strategies to try, with the
                # detected mode first so we preserve whatever the user had.
                def _start_app() -> bool:
                    try:
                        subprocess.Popen(["open", "-a", "Ollama"])
                        return True
                    except Exception as exc:
                        logger.debug("open -a Ollama failed: %s", exc)
                        return False

                def _start_serve() -> bool:
                    if not ollama_bin:
                        return False
                    try:
                        subprocess.Popen(
                            [ollama_bin, "serve"],
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL,
                            start_new_session=True,
                        )
                        return True
                    except Exception as exc:
                        logger.debug("ollama serve failed: %s", exc)
                        return False

                strategies = []
                if running_method == "app" and has_app:
                    strategies = [_start_app, _start_serve]
                elif running_method == "serve":
                    strategies = [_start_serve, _start_app] if has_app else [_start_serve]
                else:  # unknown — fall back to old behavior (prefer app on macOS)
                    if has_app:
                        strategies = [_start_app, _start_serve]
                    else:
                        strategies = [_start_serve]

                started = any(fn() for fn in strategies)
                if not started:
                    yield _json.dumps({
                        "status": "error",
                        "error": "Could not restart Ollama automatically. Please start it manually.",
                    }) + "\n"
                    return

                # Wait up to 90s for the new server to come online. macOS may
                # show a Gatekeeper / "Ollama wants to access..." prompt on
                # first launch that the user has to click through.
                for i in range(180):  # 180 * 0.5s = 90s
                    time.sleep(0.5)
                    version = _ping()
                    if version is not None:
                        # If we just restarted .app and the version didn't
                        # change, the .app's bundled binary is the bottleneck:
                        # `brew upgrade ollama` (formula) doesn't touch
                        # /Applications/Ollama.app.
                        if (
                            pre_version
                            and version == pre_version
                            and running_method == "app"
                        ):
                            message = (
                                f"Ollama is back up (v{version}), but the version is unchanged. "
                                "Ollama.app's bundled server didn't get updated by brew. "
                                "Either replace /Applications/Ollama.app with the latest from "
                                "ollama.com/download, or quit Ollama.app and run `ollama serve` "
                                "in a terminal to use the upgraded CLI binary."
                            )
                        else:
                            message = f"Ollama is back up (v{version})."
                        yield _json.dumps({
                            "status": "done",
                            "version": version,
                            "message": message,
                        }) + "\n"
                        return
                    # Heartbeat every 10s so the UI knows we're still waiting.
                    if i > 0 and i % 20 == 0:
                        elapsed = (i + 1) // 2
                        yield _json.dumps({
                            "status": f"Still waiting for Ollama ({elapsed}s)... If you see a security prompt, click Open / Allow.",
                        }) + "\n"

                yield _json.dumps({
                    "status": "error",
                    "error": "Ollama did not come back online within 90 seconds. If you saw a security prompt, finish it and then refresh.",
                }) + "\n"
            except Exception as exc:
                yield _json.dumps({"status": "error", "error": str(exc)}) + "\n"

        return Response(
            generate(),
            mimetype="application/x-ndjson",
            headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
        )

    @app.route("/api/ollama/upgrade", methods=["POST"])
    def api_ollama_upgrade():
        """Upgrade an existing Ollama install. Streams progress.

        - macOS + brew (cask or formula): runs the matching `brew upgrade`.
        - Linux: re-runs the official install script (idempotent upgrade).
        - Windows or no detectable install method: returns 400 with a download URL
          so the frontend can open the manual download page.
        """
        import json as _json

        system = platform.system()
        has_homebrew = shutil.which("brew") is not None

        if system == "Windows":
            return jsonify({
                "error": "Automatic upgrade not supported on Windows.",
                "download_url": "https://ollama.com/download",
            }), 400

        if system == "Darwin":
            if not has_homebrew:
                return jsonify({
                    "error": "Homebrew not found — please update from the Ollama site.",
                    "download_url": "https://ollama.com/download",
                }), 400
            # Try BOTH cask and formula in case the user has both installed.
            # If neither is present, exit 2 so the frontend opens the download
            # page. If formula is upgraded but /Applications/Ollama.app exists
            # without being a brew cask, warn — its bundled server binary
            # won't have been touched and will keep running the old version.
            cmd = [
                "/bin/bash", "-c",
                'set +e; '
                'has_cask=0; has_formula=0; upgraded=0; '
                'if brew list --cask ollama >/dev/null 2>&1; then has_cask=1; fi; '
                'if brew list --formula ollama >/dev/null 2>&1; then has_formula=1; fi; '
                'if [ $has_cask -eq 1 ]; then '
                '  echo "==> Upgrading Ollama.app (cask)"; '
                '  brew upgrade --cask ollama && upgraded=1; '
                'fi; '
                'if [ $has_formula -eq 1 ]; then '
                '  echo "==> Upgrading ollama CLI (formula)"; '
                '  brew upgrade ollama && upgraded=1; '
                'fi; '
                'if [ $upgraded -eq 0 ]; then '
                '  echo "Ollama was not installed via Homebrew. Update from ollama.com/download."; '
                '  exit 2; '
                'fi; '
                'if [ $has_cask -eq 0 ] && [ -d /Applications/Ollama.app ]; then '
                '  echo ""; '
                '  echo "WARNING: /Applications/Ollama.app exists but was not installed via Homebrew."; '
                '  echo "Its bundled server has NOT been updated. If Ollama.app is what is running,"; '
                '  echo "download the latest from ollama.com/download and replace /Applications/Ollama.app,"; '
                '  echo "or quit Ollama.app and start a headless server with: ollama serve"; '
                'fi'
            ]
        else:
            # Linux: install script is idempotent and handles upgrade
            cmd = ["/bin/bash", "-c", "curl -fsSL https://ollama.com/install.sh | sh"]

        def generate():
            try:
                yield _json.dumps({"status": "Upgrading Ollama..."}) + "\n"
                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                )
                for line in proc.stdout:
                    line = line.rstrip()
                    if line:
                        yield _json.dumps({"status": line}) + "\n"
                proc.wait()
                if proc.returncode == 0:
                    yield _json.dumps({
                        "status": "done",
                        "message": "Upgrade finished. Click \"Restart Ollama\" to load the new version.",
                    }) + "\n"
                else:
                    yield _json.dumps({
                        "status": "error",
                        "error": f"Upgrade exited with code {proc.returncode}",
                    }) + "\n"
            except Exception as exc:
                yield _json.dumps({"status": "error", "error": str(exc)}) + "\n"

        return Response(
            generate(),
            mimetype="application/x-ndjson",
            headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
        )

    @app.route("/api/install/<tool>", methods=["POST"])
    def api_install_tool(tool):
        """Stream the installation of an external tool."""
        import json as _json

        valid_tools = {"ollama", "piper-tts"}
        if tool not in valid_tools:
            return jsonify({"error": f"Unknown tool: {tool}"}), 400

        system = platform.system()
        has_homebrew = shutil.which("brew") is not None

        if tool == "ollama":
            if system == "Windows":
                return jsonify({
                    "error": "Download Ollama manually on Windows",
                    "download_url": "https://ollama.ai",
                }), 400
            if has_homebrew and system == "Darwin":
                cmd = ["brew", "install", "ollama"]
            else:
                cmd = ["/bin/bash", "-c", "curl -fsSL https://ollama.com/install.sh | sh"]
        elif tool == "piper-tts":
            from ..frozen import is_frozen
            if is_frozen():
                return jsonify({"error": "Package install not available in desktop app"}), 400
            packages = ["piper-tts"]
            # Install into the same environment aloud is running in
            pip_cmd = shutil.which("uv")
            if pip_cmd:
                cmd = ["uv", "pip", "install"] + packages
            else:
                cmd = [sys.executable, "-m", "pip", "install"] + packages
        else:
            return jsonify({"error": "Unknown tool"}), 400

        def generate():
            try:
                yield _json.dumps({"status": f"Installing {tool}..."}) + "\n"
                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                )
                for line in proc.stdout:
                    line = line.rstrip()
                    if line:
                        yield _json.dumps({"status": line}) + "\n"
                proc.wait()
                if proc.returncode == 0:
                    yield _json.dumps({"status": "done"}) + "\n"
                else:
                    yield _json.dumps({"status": "error", "error": f"Install exited with code {proc.returncode}"}) + "\n"
            except Exception as exc:
                yield _json.dumps({"status": "error", "error": str(exc)}) + "\n"

        return Response(
            generate(),
            mimetype="application/x-ndjson",
            headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
        )
