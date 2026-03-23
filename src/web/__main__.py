"""Allow running the web interface as python -m src.web."""

import sys

if getattr(sys, "frozen", False):
    # PyInstaller bundle — absolute imports, no CLI args
    from src.web.app import run_web
    run_web()
elif __name__ == "__main__":
    # Development — relative imports work with python -m src.web
    from .app import run_web

    import argparse
    parser = argparse.ArgumentParser(description="Glooow meditation facilitator")
    parser.add_argument("--browser", action="store_true",
                        help="Open in system browser instead of native window")
    parser.add_argument("--host", type=str, default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    run_web(host=args.host, port=args.port, debug=args.debug, browser=args.browser)
