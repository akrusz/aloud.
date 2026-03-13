"""Flask web application for the meditation facilitator."""

import atexit
import logging
import os
import signal
import sys
import threading
import time
import webbrowser
from pathlib import Path

import httpx
from flask import Flask
from flask_socketio import SocketIO

logger = logging.getLogger(__name__)

from .. import __version__
from ..config import load_config, Config
from ..updater import check_for_updates
from ..facilitation.pacing import TurnDecision
from ..logging.transcript import TranscriptLogger
from ..stt.whisper import WhisperSTT
from ..log_config import configure_logging
from ..tts import create_tts
from .auth import setup_auth
from .routes import register_routes
from .socketio_handlers import register_socketio_events


def create_app(config: Config | None = None) -> tuple[Flask, SocketIO]:
    """Create and configure the Flask application."""
    if config is None:
        config = load_config()

    app = Flask(
        __name__,
        template_folder=str(Path(__file__).parent / "templates"),
        static_folder=str(Path(__file__).parent / "static"),
    )
    app.config["SECRET_KEY"] = os.environ.get("GLOOOW_SECRET_KEY", config.web.secret_key)
    app.jinja_env.globals["glooow_version"] = __version__

    socketio = SocketIO(
        app,
        async_mode="threading",
        cors_allowed_origins=[],  # same-origin only; populated at startup
        max_http_buffer_size=10 * 1024 * 1024,  # 10MB — ~2.5min of 16kHz float32 audio
    )

    app.meditation_config = config
    app.web_sessions = {}      # session_id → WebMeditationSession
    app.sid_to_session = {}    # socket sid → session_id
    app.session_to_sid = {}    # session_id → current socket sid
    app.transcript_logger = TranscriptLogger(
        save_directory=config.session.save_directory,
        include_timestamps=config.session.include_timestamps,
    )

    # Initialize server-side TTS for high-quality audio.
    # On platforms without a server-side engine (e.g. Linux without piper),
    # create_tts may raise — fall back to None and let the browser handle TTS.
    try:
        app.server_tts = create_tts(
            engine=config.tts.engine,
            voice=config.tts.voice,
            rate=config.tts.rate,
        )
    except Exception as e:
        logger.warning("Server-side TTS unavailable (%s), using browser speechSynthesis", e)
        app.server_tts = None

    # Initialize Whisper STT — model loads in background so startup isn't blocked
    app.whisper_stt = WhisperSTT(
        model=config.stt.model,
        language=config.stt.language,
        device=config.stt.device,
    )
    app.whisper_model_ready = False
    app.whisper_lock = threading.Lock()

    register_routes(app)
    if config.auth.enabled:
        setup_auth(app, config.auth.password)
    register_socketio_events(socketio, app)

    def _check_in_loop():
        """Background loop that checks for extended silence and sends check-ins."""
        while True:
            socketio.sleep(10)  # check every 10 seconds
            for session_id, web_session in list(app.web_sessions.items()):
                if web_session.client_muted:
                    continue
                decision = web_session.pacing.should_respond()
                if decision == TurnDecision.CHECK_IN:
                    sid = app.session_to_sid.get(session_id)
                    if not sid:
                        continue
                    check_in = web_session.prompts.get_check_in_prompt()
                    web_session.session.add_assistant_message(check_in)
                    if web_session.in_silence_mode:
                        web_session.in_silence_mode = False
                        web_session.pacing.exit_silence_mode()
                        socketio.emit("silence_mode", {"active": False}, to=sid)
                    audio = None
                    if web_session.tts_enabled and app.server_tts and hasattr(app.server_tts, 'speak_to_bytes'):
                        audio = app.server_tts.speak_to_bytes(check_in)
                    socketio.emit("facilitator_message", {
                        "text": check_in,
                        "type": "response",
                        "audio": audio,
                    }, to=sid)
                    web_session.pacing.on_response_end()

    socketio.start_background_task(_check_in_loop)

    def _startup_update_check():
        """Background startup check — log if update available."""
        try:
            status = check_for_updates()
            if status.available:
                logger.info("Update available (%d commit(s) behind)", status.commits_behind)
        except Exception:
            pass

    socketio.start_background_task(_startup_update_check)

    def _load_whisper():
        """Load Whisper model in background so startup isn't blocked."""
        try:
            app.whisper_stt._load_model()
            app.whisper_model_ready = True
            logger.info("Whisper model loaded")
        except Exception as e:
            logger.error("Failed to load Whisper model: %s", e)

    socketio.start_background_task(_load_whisper)

    return app, socketio


def run_web(
    config_path: str | None = None,
    host: str | None = None,
    port: int | None = None,
    debug: bool = False,
) -> None:
    """Run the web application."""
    configure_logging()
    config = load_config(config_path)
    host = host or config.web.host
    port = port or config.web.port

    # Check if LLM proxy is reachable when using claude_proxy provider
    if config.llm.provider == "claude_proxy":
        proxy_url = config.llm.proxy_url or "http://127.0.0.1:8317"
        headers = {}
        if config.llm.api_key:
            headers["X-Api-Key"] = config.llm.api_key
        try:
            resp = httpx.get(
                f"{proxy_url.rstrip('/')}/v1/models",
                headers=headers,
                timeout=3.0,
            )
            if resp.status_code == 401:
                print(f"\n  *** CLIProxyAPI at {proxy_url} rejected our API key ***")
                print(f"  Check api-keys in ~/.cli-proxy-api/config.yaml")
                print(f"  and llm.api_key in config/default.yaml\n")
                return
        except (httpx.ConnectError, httpx.TimeoutException):
            print(f"\n  *** CLIProxyAPI is not running at {proxy_url} ***")
            print(f"  Start it with: CLIProxyAPI")
            print(f"  Then restart this server.\n")
            return

    print(f"\n{'=' * 50}")
    print(f"  Glooow v{__version__} — starting up...")
    print(f"{'=' * 50}")

    app, socketio = create_app(config)

    url = f"http://localhost:{port}"
    print(f"\n  Ready: {url}")
    print(f"  B = open browser · Q = quit\n")

    if os.environ.get("GLOOOW_AUTO_OPEN") == "1":
        def _auto_open_browser():
            for _ in range(30):
                try:
                    httpx.get(url, timeout=1)
                    print(f"  Opening {url} ...", flush=True)
                    webbrowser.open(url)
                    return
                except Exception:
                    time.sleep(0.5)
        threading.Thread(target=_auto_open_browser, daemon=True).start()

    # Background thread: keyboard shortcuts while server runs
    _saved_termios = [None]

    def _restore_terminal():
        if _saved_termios[0] is not None:
            fd, old = _saved_termios[0]
            try:
                import termios as _t
                _t.tcsetattr(fd, _t.TCSADRAIN, old)
            except Exception:
                pass

    def _shutdown(*_):
        _restore_terminal()
        print("\n  Shutting down...", flush=True)
        sys.exit(0)

    if sys.stdin.isatty():
        atexit.register(_restore_terminal)

        def _keyboard_listener():
            try:
                if sys.platform == "win32":
                    import msvcrt
                    while True:
                        ch = msvcrt.getch()
                        if ch in (b"b", b"B", b" "):
                            print(f"  Opening {url} ...", flush=True)
                            webbrowser.open(url)
                        elif ch in (b"q", b"Q"):
                            _shutdown()
                else:
                    import tty, termios
                    fd = sys.stdin.fileno()
                    old = termios.tcgetattr(fd)
                    _saved_termios[0] = (fd, old)
                    tty.setcbreak(fd)
                    while True:
                        ch = os.read(fd, 1)
                        if ch in (b"b", b"B", b" "):
                            print(f"  Opening {url} ...", flush=True)
                            webbrowser.open(url)
                        elif ch in (b"q", b"Q"):
                            _shutdown()
            except (OSError, ValueError, ImportError):
                pass

        threading.Thread(target=_keyboard_listener, daemon=True).start()

    # Ensure Ctrl+C actually exits — threading mode can swallow KeyboardInterrupt
    signal.signal(signal.SIGINT, _shutdown)

    # Allow same-origin connections from localhost and the bound host
    origins = {f"http://localhost:{port}", f"http://127.0.0.1:{port}"}
    if host not in ("127.0.0.1", "localhost"):
        origins.add(f"http://{host}:{port}")
        import socket
        try:
            local_ip = socket.gethostbyname(socket.gethostname())
            origins.add(f"http://{local_ip}:{port}")
        except socket.gaierror:
            pass
    socketio.server.cors_allowed_origins = list(origins)

    socketio.run(app, host=host, port=port, debug=debug, allow_unsafe_werkzeug=True)
