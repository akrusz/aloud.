"""Update checking and self-update for aloud."""

import json
import logging
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_CACHE_TTL = 300  # 5 minutes

GITHUB_REPO = "akrusz/aloud"


def _get_cache_file() -> Path:
    """Return the cache file path — writable location for both dev and frozen."""
    from .frozen import is_frozen
    if is_frozen():
        from .config import get_user_config_dir
        return get_user_config_dir() / ".update-cache.json"
    return _PROJECT_ROOT / ".update-cache.json"


@dataclass
class UpdateStatus:
    available: bool = False
    commits_behind: int = 0
    commit_messages: list[str] = field(default_factory=list)
    current_sha: str = ""
    remote_sha: str = ""
    error: str = ""
    is_git: bool = True
    # Release-based update fields (frozen/packaged apps)
    is_release: bool = False
    current_version: str = ""
    latest_version: str = ""
    release_notes: str = ""
    download_url: str = ""
    download_size: int = 0
    asset_name: str = ""


@dataclass
class UpdateResult:
    success: bool = False
    message: str = ""
    needs_restart: bool = False


# ---------------------------------------------------------------------------
# Version helpers
# ---------------------------------------------------------------------------

def _parse_version(v: str) -> tuple[int, ...]:
    """Parse 'v1.2.3' or '1.2.3' into (1, 2, 3)."""
    return tuple(int(x) for x in v.lstrip("v").split("."))


def _version_newer(remote: str, local: str) -> bool:
    """Return True if remote version is strictly greater than local."""
    try:
        return _parse_version(remote) > _parse_version(local)
    except (ValueError, AttributeError):
        return False


def _get_platform_asset_ext() -> str:
    """Return the expected asset file extension for this platform."""
    if sys.platform == "darwin":
        return ".dmg"
    elif sys.platform == "win32":
        return ".exe"
    else:
        return ".AppImage"


# ---------------------------------------------------------------------------
# Git helpers
# ---------------------------------------------------------------------------

def _is_git_repo() -> bool:
    return (_PROJECT_ROOT / ".git").exists()


def _run_git(*args: str, timeout: int = 30) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=_PROJECT_ROOT,
        capture_output=True,
        text=True,
        timeout=timeout,
        stdin=subprocess.DEVNULL,
    )


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------

def _load_cache() -> dict | None:
    try:
        cache_file = _get_cache_file()
        if cache_file.exists():
            data = json.loads(cache_file.read_text())
            if time.time() - data.get("ts", 0) < _CACHE_TTL:
                return data
    except Exception as e:
        logger.debug("Failed to load update cache: %s", e)
    return None


def _save_cache(status: UpdateStatus) -> None:
    try:
        cache_file = _get_cache_file()
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(json.dumps({
            "ts": time.time(),
            "available": status.available,
            "commits_behind": status.commits_behind,
            "commit_messages": status.commit_messages,
            "current_sha": status.current_sha,
            "remote_sha": status.remote_sha,
            "is_git": status.is_git,
            "is_release": status.is_release,
            "current_version": status.current_version,
            "latest_version": status.latest_version,
            "release_notes": status.release_notes,
            "download_url": status.download_url,
            "download_size": status.download_size,
            "asset_name": status.asset_name,
        }))
    except Exception as e:
        logger.debug("Failed to save update cache: %s", e)


def _clear_cache() -> None:
    try:
        _get_cache_file().unlink(missing_ok=True)
    except Exception as e:
        logger.debug("Failed to clear update cache: %s", e)


# ---------------------------------------------------------------------------
# Update check
# ---------------------------------------------------------------------------

def check_for_updates(force: bool = False) -> UpdateStatus:
    """Check if updates are available.

    Uses git if available, GitHub Releases for frozen apps,
    falls back to GitHub API for non-git installs.
    Results are cached for 5 minutes unless force=True.
    """
    from .frozen import is_frozen

    if not force:
        cached = _load_cache()
        if cached is not None:
            return UpdateStatus(
                available=cached["available"],
                commits_behind=cached["commits_behind"],
                commit_messages=cached.get("commit_messages", []),
                current_sha=cached.get("current_sha", ""),
                remote_sha=cached.get("remote_sha", ""),
                is_git=cached.get("is_git", True),
                is_release=cached.get("is_release", False),
                current_version=cached.get("current_version", ""),
                latest_version=cached.get("latest_version", ""),
                release_notes=cached.get("release_notes", ""),
                download_url=cached.get("download_url", ""),
                download_size=cached.get("download_size", 0),
                asset_name=cached.get("asset_name", ""),
            )

    if is_frozen():
        status = _check_github_releases()
    elif _is_git_repo():
        status = _check_git()
    else:
        status = _check_github_api()

    _save_cache(status)
    return status


# ---------------------------------------------------------------------------
# Check strategies
# ---------------------------------------------------------------------------

def _git_or_error(
    status: UpdateStatus, *args: str, error_msg: str, **kwargs,
) -> str | None:
    """Run a git command; on failure set status.error and return None."""
    result = _run_git(*args, **kwargs)
    if result.returncode != 0:
        status.error = error_msg
        return None
    return result.stdout.strip()


def _check_git() -> UpdateStatus:
    """Check for updates using git."""
    from . import __version__
    status = UpdateStatus(is_git=True, current_version=__version__)

    try:
        sha = _git_or_error(status, "rev-parse", "HEAD",
                            error_msg="Could not determine current version")
        if sha is None:
            return status
        status.current_sha = sha[:12]

        # Fetch via HTTPS so we never trigger SSH auth prompts on public repos
        https_url = f"https://github.com/{GITHUB_REPO}.git"
        if _git_or_error(status, "fetch", https_url, "main:refs/remotes/origin/main",
                         "--quiet",
                         error_msg="Could not reach update server",
                         timeout=5) is None:
            return status

        count = _git_or_error(status, "rev-list", "--count", "HEAD..origin/main",
                              error_msg="Could not compare versions")
        if count is None:
            return status

        behind = int(count)
        status.commits_behind = behind
        status.available = behind > 0

        remote = _git_or_error(status, "rev-parse", "origin/main",
                               error_msg="")
        if remote is not None:
            status.remote_sha = remote[:12]

        if behind > 0:
            msgs = _git_or_error(
                status, "log", "--oneline", "--format=%s",
                "HEAD..origin/main", f"-{min(behind, 20)}",
                error_msg="",
            )
            if msgs:
                status.commit_messages = [
                    line.strip() for line in msgs.splitlines() if line.strip()
                ]

    except subprocess.TimeoutExpired:
        status.error = "Update check timed out"
    except Exception as e:
        status.error = str(e)

    return status


def _check_github_api() -> UpdateStatus:
    """Check for updates via GitHub API (non-git installs)."""
    status = UpdateStatus(is_git=False)

    try:
        resp = httpx.get(
            f"https://api.github.com/repos/{GITHUB_REPO}/commits/main",
            headers={"Accept": "application/vnd.github.v3+json"},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        remote_sha = data["sha"][:12]
        status.remote_sha = remote_sha

        # Without git we can't determine the local version
        status.available = True
        status.commits_behind = 1  # Can't determine exact count without git
        msg = data.get("commit", {}).get("message", "").split("\n")[0]
        if msg:
            status.commit_messages = [msg]

    except Exception as e:
        status.error = f"Could not check for updates: {e}"

    return status


def _check_github_releases() -> UpdateStatus:
    """Check for updates via GitHub Releases (frozen/packaged apps)."""
    from . import __version__
    status = UpdateStatus(
        is_git=False, is_release=True, current_version=__version__,
    )

    try:
        resp = httpx.get(
            f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest",
            headers={"Accept": "application/vnd.github.v3+json"},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()

        tag = data.get("tag_name", "")
        status.latest_version = tag.lstrip("v")
        notes = data.get("body", "") or ""
        # Strip CI-appended install notes (not useful in-app)
        if "<!-- install-notes -->" in notes:
            notes = notes.split("<!-- install-notes -->")[0]
        status.release_notes = notes.strip()

        if _version_newer(tag, __version__):
            status.available = True

            # Find the platform-appropriate asset by extension
            ext = _get_platform_asset_ext()
            for asset in data.get("assets", []):
                if asset["name"].endswith(ext):
                    status.download_url = asset["browser_download_url"]
                    status.download_size = asset.get("size", 0)
                    status.asset_name = asset["name"]
                    break

            if not status.download_url:
                status.error = "No installer found for this platform"
                status.available = False

    except Exception as e:
        status.error = f"Could not check for updates: {e}"

    return status


# ---------------------------------------------------------------------------
# Apply updates
# ---------------------------------------------------------------------------

def apply_update() -> UpdateResult:
    """Pull the latest version and update dependencies."""
    if not _is_git_repo():
        return UpdateResult(
            success=False,
            message=(
                "Not a git installation — automatic updates aren't available. "
                "To update, run the setup script again:\n\n"
                "  curl -fsSL https://raw.githubusercontent.com/akrusz/aloud"
                "/main/scripts/setup.sh | bash"
            ),
        )

    # Check for uncommitted changes to tracked files (ignore user data dirs)
    result = _run_git(
        "status", "--porcelain", "--untracked-files=no",
    )
    if result.returncode == 0 and result.stdout.strip():
        # Filter out user-data directories
        ignore_prefixes = ("sessions/", "config/", ".beads/")
        changes = [
            line for line in result.stdout.strip().splitlines()
            if not any(line[3:].startswith(p) for p in ignore_prefixes)
        ]
        if changes:
            return UpdateResult(
                success=False,
                message="You have uncommitted changes to tracked files. Please commit or stash them first.",
            )

    # Pull latest via HTTPS (avoids SSH auth prompts on public repos)
    https_url = f"https://github.com/{GITHUB_REPO}.git"
    result = _run_git("pull", https_url, "main", "--ff-only", timeout=30)
    if result.returncode != 0:
        err = result.stderr.strip() or result.stdout.strip()
        return UpdateResult(
            success=False,
            message=f"Update failed: {err}",
        )

    # Update dependencies
    try:
        subprocess.run(
            ["uv", "pip", "install", "--quiet", "-r", "requirements.txt"],
            cwd=_PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except Exception as e:
        logger.debug("Dependency update skipped: %s", e)  # Non-fatal — deps may already be up to date

    _clear_cache()

    return UpdateResult(
        success=True,
        message="Updated successfully. Restart aloud to use the new version.",
        needs_restart=True,
    )


def download_release(download_url: str, asset_name: str) -> UpdateResult:
    """Download a release asset and open it for the user to install."""
    import tempfile

    if not download_url:
        return UpdateResult(success=False, message="No download URL available.")

    try:
        download_dir = Path(tempfile.gettempdir()) / "aloud-updates"
        download_dir.mkdir(exist_ok=True)
        dest = download_dir / asset_name

        with httpx.stream("GET", download_url, follow_redirects=True, timeout=120) as resp:
            resp.raise_for_status()
            with open(dest, "wb") as f:
                for chunk in resp.iter_bytes(chunk_size=8192):
                    f.write(chunk)

        # Open the installer
        if sys.platform == "darwin":
            subprocess.Popen(["open", str(dest)])
        elif sys.platform == "win32":
            os.startfile(str(dest))
        else:
            # Linux: make executable and open containing folder
            dest.chmod(0o755)
            subprocess.Popen(["xdg-open", str(dest.parent)])

        _clear_cache()

        return UpdateResult(
            success=True,
            message="Download complete. The installer has been opened. "
                    "Close aloud, then install the new version.",
            needs_restart=True,
        )
    except Exception as e:
        return UpdateResult(success=False, message=f"Download failed: {e}")
