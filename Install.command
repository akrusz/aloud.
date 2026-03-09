#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
./scripts/install.sh
echo ""; echo "  Done! Double-click Start.command to launch."
echo "  Press any key to close..."; read -n 1 -s
