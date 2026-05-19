#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────
# aloud — Run the web server directly
#
# Lightweight alternative to start.sh: just the
# server, no proxy auto-start or banner.
# ─────────────────────────────────────────────────

cd "$(dirname "$0")/.."

if ! command -v uv &>/dev/null; then
    echo "  uv not found. Run ./scripts/start.sh first or install uv: https://docs.astral.sh/uv/"
    exit 1
fi

uv run python -m src.web
