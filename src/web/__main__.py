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
    parser = argparse.ArgumentParser(description="aloud — voice meditation facilitator")
    parser.add_argument("--browser", action="store_true",
                        help="Open in system browser instead of native window")
    parser.add_argument("--host", type=str, default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--list-sessions", action="store_true",
                        help="List all saved sessions")
    parser.add_argument("--view-session", type=str, metavar="ID",
                        help="View a specific session transcript")
    parser.add_argument("--check-update", action="store_true",
                        help="Check if a new version is available")
    parser.add_argument("--update", action="store_true",
                        help="Update aloud to the latest version")
    parser.add_argument("--fresh", action="store_true",
                        help="Simulate a fresh install (first-run UI, cleared state)")
    parser.add_argument("--hide-premium", action="store_true",
                        help="Hide Premium/Enhanced voices (test low-quality voice UX)")
    parser.add_argument("--no-voices", action="store_true",
                        help="Return empty voice list (test no-voices UX)")
    parser.add_argument("--reset-piper", action="store_true",
                        help="Pretend Piper isn't installed (hides from engine list & recommendations)")
    parser.add_argument("--no-providers", action="store_true",
                        help="All LLM providers appear unavailable (test cold-start setup)")
    parser.add_argument("--no-ollama", action="store_true",
                        help="Ollama appears not installed (test Ollama install flow)")
    args = parser.parse_args()

    # Utility commands (no server needed)
    if args.check_update:
        from .. import __version__
        from ..updater import check_for_updates
        print(f"aloud v{__version__}")
        status = check_for_updates(force=True)
        if status.error:
            print(f"Error: {status.error}")
        elif status.available:
            print(f"Update available! ({status.commits_behind} commit(s) behind)")
            for msg in status.commit_messages:
                print(f"  - {msg}")
        else:
            print("You're up to date.")
        sys.exit(0)

    if args.update:
        from .. import __version__
        from ..updater import apply_update
        print(f"aloud v{__version__} — updating...")
        result = apply_update()
        print(result.message)
        sys.exit(0)

    if args.list_sessions or args.view_session:
        from ..config import load_config
        from ..logging.transcript import TranscriptLogger
        config = load_config()
        logger = TranscriptLogger(save_directory=config.session.save_directory)
        if args.list_sessions:
            sessions = logger.list_sessions()
            if not sessions:
                print("No saved sessions found.")
            else:
                for s in sessions:
                    dur = s.get("duration")
                    dur_str = f"{int(dur // 60)}m {int(dur % 60)}s" if dur else "unknown"
                    print(f"  {s['session_id']}  ({dur_str}, {s.get('exchange_count', 0)} exchanges)")
        else:
            session = logger.load_session(args.view_session)
            if not session:
                print(f"Session not found: {args.view_session}")
            else:
                for ex in session.get("exchanges", []):
                    print(f"{ex['role'].capitalize()}: {ex['content']}\n")
        sys.exit(0)

    run_web(host=args.host, port=args.port, debug=args.debug, browser=args.browser,
            fresh=args.fresh, hide_premium=args.hide_premium,
            no_voices=args.no_voices, reset_piper=args.reset_piper,
            no_providers=args.no_providers, no_ollama=args.no_ollama)
