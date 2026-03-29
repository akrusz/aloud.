"""Tool installation HTTP route handlers."""

import platform
import shutil
import subprocess
import sys

from flask import Flask, jsonify, Response


def register_tool_routes(app: Flask) -> None:
    """Register tool installation routes."""

    @app.route("/api/install/<tool>", methods=["POST"])
    def api_install_tool(tool):
        """Stream the installation of an external tool."""
        import json as _json

        valid_tools = {"cliproxyapi", "ollama", "piper-tts", "vibevoice"}
        if tool not in valid_tools:
            return jsonify({"error": f"Unknown tool: {tool}"}), 400

        system = platform.system()
        has_homebrew = shutil.which("brew") is not None

        if tool == "cliproxyapi":
            if system == "Windows":
                return jsonify({
                    "error": "Download CLIProxyAPI manually on Windows",
                    "download_url": "https://github.com/router-for-me/CLIProxyAPI/releases",
                }), 400
            if has_homebrew:
                cmd = ["brew", "install", "cliproxyapi"]
            else:
                cmd = [
                    "/bin/bash", "-c",
                    "curl -fsSL https://raw.githubusercontent.com/brokechubb/cliproxyapi-installer/refs/heads/master/cliproxyapi-installer | bash",
                ]
        elif tool == "ollama":
            if system == "Windows":
                return jsonify({
                    "error": "Download Ollama manually on Windows",
                    "download_url": "https://ollama.ai",
                }), 400
            if has_homebrew and system == "Darwin":
                cmd = ["brew", "install", "ollama"]
            else:
                cmd = ["/bin/bash", "-c", "curl -fsSL https://ollama.com/install.sh | sh"]
        elif tool in ("piper-tts", "vibevoice"):
            from ..frozen import is_frozen
            if is_frozen():
                return jsonify({"error": "Package install not available in desktop app"}), 400
            packages = ["piper-tts"] if tool == "piper-tts" else ["vibevoice[streamingtts]", "torch"]
            # Install into the same environment glooow is running in
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
