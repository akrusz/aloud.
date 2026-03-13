"""Logging configuration for the src namespace."""

import logging
import sys


def configure_logging(level: int = logging.INFO) -> None:
    """Configure structured logging for the 'src' package.

    Call once from each entry point (web and CLI) before any other work.
    """
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter(
        "  [%(name)s] %(message)s",
    ))

    root = logging.getLogger("src")
    if not root.handlers:
        root.addHandler(handler)
    root.setLevel(level)
