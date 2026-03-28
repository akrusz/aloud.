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
    parser = argparse.ArgumentParser(description="glooow meditation facilitator")
    parser.add_argument("--browser", action="store_true",
                        help="Open in system browser instead of native window")
    parser.add_argument("--host", type=str, default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--fresh", action="store_true",
                        help="Simulate a fresh install (first-run UI, cleared state)")
    parser.add_argument("--hide-premium", action="store_true",
                        help="Hide Premium/Enhanced voices (test low-quality voice UX)")
    parser.add_argument("--no-voices", action="store_true",
                        help="Return empty voice list (test no-voices UX)")
    parser.add_argument("--reset-piper", action="store_true",
                        help="Pretend Piper voices aren't downloaded (test download flow)")
    args = parser.parse_args()

    run_web(host=args.host, port=args.port, debug=args.debug, browser=args.browser,
            fresh=args.fresh, hide_premium=args.hide_premium,
            no_voices=args.no_voices, reset_piper=args.reset_piper)
