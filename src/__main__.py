"""Allow running as python -m src — delegates to the web interface."""

import runpy
import sys

if __name__ == "__main__":
    runpy.run_module("src.web", run_name="__main__", alter_sys=True)
