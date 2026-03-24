"""Configuration-related HTTP route handlers."""

import logging
import platform
import subprocess

from flask import Flask, request, jsonify

from ..config import (
    has_user_config, save_user_config,
    config_to_dict, load_config, get_user_config_path,
    sync_api_key_to_env,
)
from ..tts import create_tts

logger = logging.getLogger(__name__)


def register_config_routes(app: Flask) -> None:
    """Register config GET/POST and related utility routes."""

    @app.route("/api/config", methods=["GET"])
    def api_config_get():
        """Return the current merged configuration (with API keys masked)."""
        cfg = config_to_dict(app.meditation_config)
        # Mask sensitive fields
        if cfg.get("llm", {}).get("api_key"):
            key = cfg["llm"]["api_key"]
            if len(key) > 8:
                cfg["llm"]["api_key"] = key[:4] + "..." + key[-4:]
            else:
                cfg["llm"]["api_key"] = "***"
        if cfg.get("tts", {}).get("api_key"):
            key = cfg["tts"]["api_key"]
            if len(key) > 8:
                cfg["tts"]["api_key"] = key[:4] + "..." + key[-4:]
            else:
                cfg["tts"]["api_key"] = "***"
        cfg["_has_user_config"] = has_user_config()
        cfg["_config_path"] = str(get_user_config_path())
        return jsonify(cfg)

    @app.route("/api/config", methods=["POST"])
    def api_config_save():
        """Save user configuration overrides."""
        data = request.get_json()
        if not data:
            return jsonify({"error": "No data provided"}), 400

        try:
            path = save_user_config(data)

            # Reload config into the running app
            new_config = load_config()
            app.meditation_config = new_config
            app.jinja_env.globals["text_scale"] = new_config.web.text_scale
            sync_api_key_to_env(new_config)

            # Recreate server TTS if the engine/voice/rate changed
            try:
                app.server_tts = create_tts(
                    engine=new_config.tts.engine,
                    voice=new_config.tts.voice,
                    rate=new_config.tts.rate,
                )
            except Exception as e:
                logger.debug("Server-side TTS unavailable after config change: %s", e)
                app.server_tts = None

            return jsonify({"saved": True, "path": str(path)})
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.route("/api/open-config-folder", methods=["POST"])
    def api_open_config_folder():
        """Open the config file's parent folder in the system file browser."""
        folder = str(get_user_config_path().parent)
        system = platform.system()
        try:
            if system == "Darwin":
                subprocess.Popen(["open", folder])
            elif system == "Windows":
                subprocess.Popen(["explorer", folder])
            else:
                subprocess.Popen(["xdg-open", folder])
            return jsonify({"ok": True})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 500
