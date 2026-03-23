"""Utilities for PyInstaller frozen bundles.

When the app is bundled with PyInstaller, resource paths must be resolved
relative to sys._MEIPASS instead of the source tree. This module provides
helpers that work in both development and frozen modes.
"""

import sys
from pathlib import Path


def is_frozen() -> bool:
    """Return True if running inside a PyInstaller bundle."""
    return getattr(sys, "frozen", False)


def get_base_path() -> Path:
    """Return the base path for bundled resources.

    In frozen mode, this is the PyInstaller _MEIPASS temp directory.
    In development, this is the project root (parent of src/).
    """
    if is_frozen():
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return Path(__file__).resolve().parent.parent


def get_resource_path(relative: str) -> Path:
    """Resolve a resource path that works in both dev and frozen mode."""
    return get_base_path() / relative
