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
from flask import Flask, request
from flask_socketio import SocketIO

from .. import __version__
from ..config import load_config, Config, sync_api_key_to_env
from ..logging.transcript import TranscriptLogger
from ..stt.whisper_cpp import WhisperCppSTT
from ..log_config import configure_logging
from ..tts import create_tts
from ..frozen import is_frozen, get_resource_path
from .auth import setup_auth
from .background import start_background_tasks
from .routes import register_routes
from .socketio_handlers import register_socketio_events

logger = logging.getLogger(__name__)


def create_app(config: Config | None = None) -> tuple[Flask, SocketIO]:
    """Create and configure the Flask application."""
    if config is None:
        config = load_config()

    app = _create_flask_app(config)
    socketio = _create_socketio(app)

    app.meditation_config = config
    sync_api_key_to_env(config)

    _init_session_state(app)
    _init_transcript_logger(app, config)
    _init_tts(app, config)
    _init_whisper(app, config)

    register_routes(app)
    if config.auth.enabled:
        setup_auth(app, config.auth.password)
    register_socketio_events(socketio, app)

    start_background_tasks(app, socketio, config)

    return app, socketio


def _create_flask_app(config: Config) -> Flask:
    """Create the Flask app with template/static folders, config, and Jinja globals."""
    if is_frozen():
        template_folder = str(get_resource_path("src/web/templates"))
        static_folder = str(get_resource_path("src/web/static"))
    else:
        template_folder = str(Path(__file__).parent / "templates")
        static_folder = str(Path(__file__).parent / "static")

    app = Flask(
        __name__,
        template_folder=template_folder,
        static_folder=static_folder,
    )
    app.config["SECRET_KEY"] = os.environ.get("GLOOOW_SECRET_KEY", config.web.secret_key)
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
    app.jinja_env.globals["glooow_version"] = __version__
    app.jinja_env.globals["text_scale"] = config.web.text_scale
    app.jinja_env.globals["frameless"] = config.web.frameless

    @app.after_request
    def _no_cache_js(response):
        """Prevent browser from caching JS files (including ES module imports)."""
        if request.path.endswith('.js') or request.path.endswith('.css'):
            response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
            response.headers['Pragma'] = 'no-cache'
            response.headers['Expires'] = '0'
        return response

    return app


def _create_socketio(app: Flask) -> SocketIO:
    """Create the SocketIO instance with threading async mode."""
    return SocketIO(
        app,
        async_mode="threading",
        cors_allowed_origins=[],  # same-origin only; populated at startup
        max_http_buffer_size=10 * 1024 * 1024,  # 10MB — ~2.5min of 16kHz float32 audio
    )


def _init_session_state(app: Flask) -> None:
    """Initialize session tracking dictionaries on the app."""
    app.web_sessions = {}      # session_id -> WebMeditationSession
    app.sid_to_session = {}    # socket sid -> session_id
    app.session_to_sid = {}    # session_id -> current socket sid


def _init_transcript_logger(app: Flask, config: Config) -> None:
    """Set up the transcript logger."""
    app.transcript_logger = TranscriptLogger(
        save_directory=config.session.save_directory,
        include_timestamps=config.session.include_timestamps,
    )


def _init_tts(app: Flask, config: Config) -> None:
    """Initialize server-side TTS engine, falling back to None on failure.

    When server TTS is None, the browser speechSynthesis API handles TTS instead.
    """
    try:
        app.server_tts = create_tts(
            engine=config.tts.engine,
            voice=config.tts.voice,
            rate=config.tts.rate,
        )
    except Exception as e:
        logger.warning("Server-side TTS unavailable (%s), using browser speechSynthesis", e)
        app.server_tts = None


def _init_whisper(app: Flask, config: Config) -> None:
    """Create the Whisper STT instance (model loads later in a background task)."""
    app.whisper_stt = WhisperCppSTT(
        model=config.stt.model,
        language=config.stt.language,
    )
    app.whisper_model_ready = False
    app.whisper_lock = threading.Lock()


def _configure_cors(socketio, host: str, port: int, https_port: int | None = None) -> None:
    """Set up CORS allowed origins for the SocketIO server."""
    origins = {f"http://localhost:{port}", f"http://127.0.0.1:{port}"}
    if https_port:
        origins.update({
            f"https://localhost:{https_port}",
            f"https://127.0.0.1:{https_port}",
        })
    if host not in ("127.0.0.1", "localhost"):
        origins.add(f"http://{host}:{port}")
        if https_port:
            origins.add(f"https://{host}:{https_port}")
        import socket
        try:
            local_ip = socket.gethostbyname(socket.gethostname())
            origins.add(f"http://{local_ip}:{port}")
            if https_port:
                origins.add(f"https://{local_ip}:{https_port}")
        except socket.gaierror:
            pass
    socketio.server.cors_allowed_origins = list(origins)


def _set_macos_app_name(name: str) -> None:
    """Set the macOS Dock and Cmd+Tab display name (no-op on other platforms)."""
    if sys.platform != "darwin":
        return
    try:
        from Foundation import NSBundle
        info = NSBundle.mainBundle().infoDictionary()
        info["CFBundleName"] = name
        info["CFBundleDisplayName"] = name
    except Exception as e:
        logger.debug("Could not set macOS app name: %s", e)


def _stop_proxy(app) -> None:
    """Terminate CLIProxyAPI if we started it."""
    proc = getattr(app, "proxy_process", None)
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except Exception as e:
            logger.debug("Proxy did not exit gracefully, killing: %s", e)
            proc.kill()


def _shutdown_all(flask_app=None) -> None:
    """Clean up child processes and exit."""
    print("\n  Window closed. Shutting down...", flush=True)

    # Kill CLIProxyAPI immediately if we started it
    if flask_app:
        proc = getattr(flask_app, "proxy_process", None)
        if proc and proc.poll() is None:
            try:
                proc.kill()
                proc.wait(timeout=1)
            except Exception:
                pass

    # Force exit — os._exit bypasses all cleanup, atexit, threads, etc.
    # This is intentional: the Flask server thread would otherwise keep
    # the process alive indefinitely after the window closes.
    os._exit(0)


def _get_geometry_path() -> Path:
    """Return path to the saved window geometry file."""
    from ..config import get_user_config_dir
    return get_user_config_dir() / "window_geometry.json"


def _load_geometry() -> dict | None:
    """Load saved window position/size, or None if not saved."""
    import json
    path = _get_geometry_path()
    if not path.exists():
        return None
    try:
        with open(path) as f:
            geo = json.load(f)
        # Reject if width/height are missing or null
        if not geo.get("width") or not geo.get("height"):
            return None
        return geo
    except Exception as e:
        logger.debug("Failed to load window geometry: %s", e)
        return None


def _save_geometry(window) -> None:
    """Save current window position/size for next launch."""
    import json
    try:
        geo = {"x": window.x, "y": window.y,
               "width": window.width, "height": window.height}
        path = _get_geometry_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w") as f:
            json.dump(geo, f)
    except Exception as e:
        logger.debug("Failed to save window geometry: %s", e)


def _grant_media_permissions() -> None:
    """Patch pywebview's WKWebView delegate to auto-grant microphone access.

    WKWebView requires a WKUIDelegate method to handle getUserMedia requests.
    pywebview doesn't implement it, so WebKit prompts (or denies) every time.
    This adds the method to auto-grant audio/video capture.
    """
    if sys.platform != "darwin":
        return
    try:
        import objc
        import WebKit
        from webview.platforms.cocoa import BrowserView

        BrowserDelegate = BrowserView.BrowserDelegate

        sel = b"webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:"

        def _auto_grant_media(self, webview, origin, frame, _type, handler):
            handler(WebKit.WKPermissionDecisionGrant)

        typed_method = objc.selector(
            _auto_grant_media,
            selector=sel,
            signature=b"v@:@@@q@?",
        )
        objc.classAddMethod(BrowserDelegate, sel, typed_method)
        logger.info("Patched WKWebView to auto-grant microphone access")
    except Exception as e:
        logger.warning("Could not patch media permissions: %s", e)


def _run_webview(app, socketio, host: str, port: int, window_mode: str = "remember",
                 frameless: bool = False, vibrancy: bool = False) -> None:
    """Run with a native pywebview window. Flask serves in a background thread."""
    import webview

    _set_macos_app_name("glooow")
    _grant_media_permissions()

    url = f"http://localhost:{port}"

    def _start_server():
        _configure_cors(socketio, host, port)
        socketio.run(app, host=host, port=port, allow_unsafe_werkzeug=True)

    server_thread = threading.Thread(target=_start_server, daemon=True)
    server_thread.start()

    # Wait for the server to be ready
    for _ in range(60):
        try:
            httpx.get(url, timeout=1)
            break
        except Exception:
            time.sleep(0.25)

    # Determine window parameters based on mode
    win_kwargs = {
        "frameless": frameless,
        "easy_drag": False,
        "vibrancy": vibrancy,
    }

    if window_mode == "fullscreen":
        win_kwargs.update(width=910, height=820, fullscreen=True)
    elif window_mode == "maximized":
        win_kwargs.update(width=910, height=820, maximized=True)
    elif window_mode == "small":
        win_kwargs.update(width=910, height=820)
    elif window_mode == "remember":
        geo = _load_geometry()
        if geo:
            win_kwargs.update(
                x=geo.get("x"), y=geo.get("y"),
                width=geo.get("width", 910), height=geo.get("height", 820),
            )
        else:
            # First launch — maximized
            win_kwargs.update(width=910, height=820, maximized=True)
    else:
        win_kwargs.update(width=910, height=820, maximized=True)

    window = webview.create_window(
        f"glooow v{__version__}",
        url,
        **win_kwargs,
    )
    app.webview_window = window

    # Save geometry when the window is about to close (while properties are still valid)
    if window_mode == "remember":
        def _on_closing():
            _save_geometry(window)
        window.events.closing += _on_closing

    # Ensure cleanup when the window closes (Cmd+W on macOS closes the window
    # but the NSApplication stays alive, so webview.start() never returns).
    window.events.closed += lambda: _shutdown_all(app)

    # webview.start() blocks until the window is closed (must be on main thread)
    # private_mode=False persists WebKit data (mic permissions, localStorage)
    # storage_path keeps it in the app's config directory
    from ..config import get_user_config_dir
    webview.start(
        private_mode=False,
        storage_path=str(get_user_config_dir() / "webview"),
    )
    _shutdown_all(app)


def _start_https_server(app, host: str, port: int, cert_pair: tuple[str, str]) -> bool:
    """Start an HTTPS server alongside the main HTTP server for LAN clients.

    Returns True if the server started successfully.
    """
    import ssl
    from werkzeug.serving import make_server

    cert_path, key_path = cert_pair
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert_path, key_path)

    try:
        server = make_server(host, port, app, ssl_context=ctx, threaded=True)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return True
    except OSError as e:
        logger.warning("Could not start HTTPS server on port %d: %s", port, e)
        return False


def _run_browser(app, socketio, host: str, port: int, debug: bool) -> None:
    """Run with browser UI and terminal keyboard shortcuts."""
    url = f"http://localhost:{port}"
    is_lan = host not in ("127.0.0.1", "localhost")
    https_port = None

    # LAN mode: start an HTTPS server so remote browsers can use the mic
    if is_lan:
        import socket as _sock
        from flask import render_template as _rt
        from .cert import ensure_cert
        from ..config import get_user_config_dir

        try:
            local_ip = _sock.gethostbyname(_sock.gethostname())
        except _sock.gaierror:
            local_ip = host

        cert_pair = ensure_cert(get_user_config_dir() / "certs", local_ip)
        if cert_pair:
            https_port = port + 1
            if _start_https_server(app, host, https_port, cert_pair):
                app.https_port = https_port

                # Redirect non-localhost HTTP requests to the setup page
                @app.before_request
                def _lan_https_redirect():
                    if (request.remote_addr not in ("127.0.0.1", "::1")
                            and not request.is_secure
                            and not request.path.startswith("/static/")):
                        req_host = request.host.split(":")[0]
                        https_url = f"https://{req_host}:{https_port}"
                        return _rt("lan_setup.html", https_url=https_url)
            else:
                https_port = None

    print(f"\n  Ready: {url}")
    if https_port:
        import socket as _sock
        try:
            local_ip = _sock.gethostbyname(_sock.gethostname())
        except _sock.gaierror:
            local_ip = host
        print(f"  LAN:   http://{local_ip}:{port}  (will guide users to HTTPS)")
        print(f"         https://{local_ip}:{https_port}  (mic-enabled)")
    print("  B = open browser · Q = quit\n")

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

    _saved_termios = [None]

    def _restore_terminal():
        if _saved_termios[0] is not None:
            fd, old = _saved_termios[0]
            try:
                import termios as _t
                _t.tcsetattr(fd, _t.TCSADRAIN, old)
            except Exception as e:
                logger.debug("Failed to restore terminal settings: %s", e)

    _shutting_down = [False]

    def _shutdown(*_):
        if _shutting_down[0]:
            return
        _shutting_down[0] = True
        _restore_terminal()
        _stop_proxy(app)
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
                    import tty
                    import termios
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

    signal.signal(signal.SIGINT, _shutdown)
    _configure_cors(socketio, host, port, https_port)
    socketio.run(app, host=host, port=port, debug=debug, allow_unsafe_werkzeug=True)


def run_web(
    config_path: str | None = None,
    host: str | None = None,
    port: int | None = None,
    debug: bool = False,
    browser: bool = False,
) -> None:
    """Run the web application.

    By default, opens in a native window via pywebview.
    Pass browser=True (or --browser on CLI) to use the system browser instead.
    """
    import logging as _logging
    configure_logging(level=_logging.DEBUG if debug else _logging.WARNING)
    config = load_config(config_path)
    host = host or config.web.host
    port = port or config.web.port

    print(f"\n{'=' * 50}")
    print(f"  glooow v{__version__} — starting up...")
    print(f"  http://localhost:{port}")
    print(f"{'=' * 50}")

    app, socketio = create_app(config)

    # Decide whether to use pywebview or browser
    use_webview = not browser
    if use_webview:
        try:
            import webview  # noqa: F401
        except ImportError:
            logger.info("pywebview not installed, falling back to browser mode")
            use_webview = False

    if use_webview:
        _run_webview(app, socketio, host, port,
                     window_mode=config.web.window_mode,
                     frameless=config.web.frameless,
                     vibrancy=config.web.vibrancy)
    else:
        _run_browser(app, socketio, host, port, debug)
