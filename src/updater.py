"""Update checking and self-update for Glooow."""

import json
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx

# Cache file lives in the project root
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_CACHE_FILE = _PROJECT_ROOT / ".update-cache.json"
_CACHE_TTL = 3600  # 1 hour

GITHUB_REPO = "akrusz/glooow"


@dataclass
class UpdateStatus:
    available: bool = False
    commits_behind: int = 0
    commit_messages: list[str] = field(default_factory=list)
    current_sha: str = ""
    remote_sha: str = ""
    error: str = ""
    is_git: bool = True


@dataclass
class UpdateResult:
    success: bool = False
    message: str = ""
    needs_restart: bool = False


def _is_git_repo() -> bool:
    return (_PROJECT_ROOT / ".git").exists()


def _run_git(*args: str, timeout: int = 30) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=_PROJECT_ROOT,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _load_cache() -> dict | None:
    try:
        if _CACHE_FILE.exists():
            data = json.loads(_CACHE_FILE.read_text())
            if time.time() - data.get("ts", 0) < _CACHE_TTL:
                return data
    except Exception:
        pass
    return None


def _save_cache(status: UpdateStatus) -> None:
    try:
        _CACHE_FILE.write_text(json.dumps({
            "ts": time.time(),
            "available": status.available,
            "commits_behind": status.commits_behind,
            "commit_messages": status.commit_messages,
            "current_sha": status.current_sha,
            "remote_sha": status.remote_sha,
            "is_git": status.is_git,
        }))
    except Exception:
        pass


def _clear_cache() -> None:
    try:
        _CACHE_FILE.unlink(missing_ok=True)
    except Exception:
        pass


def check_for_updates(force: bool = False) -> UpdateStatus:
    """Check if updates are available.

    Uses git if available, falls back to GitHub API.
    Results are cached for 1 hour unless force=True.
    """
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
            )

    if _is_git_repo():
        status = _check_git()
    else:
        status = _check_github_api()

    _save_cache(status)
    return status


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
    status = UpdateStatus(is_git=True)

    try:
        sha = _git_or_error(status, "rev-parse", "HEAD",
                            error_msg="Could not determine current version")
        if sha is None:
            return status
        status.current_sha = sha[:12]

        if _git_or_error(status, "fetch", "origin", "main", "--quiet",
                         error_msg="Could not reach update server",
                         timeout=15) is None:
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

        # Try to get local SHA from a marker file or git
        try:
            result = _run_git("rev-parse", "HEAD")
            if result.returncode == 0:
                status.current_sha = result.stdout.strip()[:12]
                status.available = status.current_sha != remote_sha
        except Exception:
            # Can't determine local version — assume update available
            status.available = True

        if status.available:
            status.commits_behind = 1  # Can't determine exact count without git
            msg = data.get("commit", {}).get("message", "").split("\n")[0]
            if msg:
                status.commit_messages = [msg]

    except Exception as e:
        status.error = f"Could not check for updates: {e}"

    return status


def apply_update() -> UpdateResult:
    """Pull the latest version and update dependencies."""
    if not _is_git_repo():
        return UpdateResult(
            success=False,
            message="Not a git installation. Re-run the install script to update.",
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
            if not any(line.strip().lstrip("MADRCU? ").startswith(p) for p in ignore_prefixes)
        ]
        if changes:
            return UpdateResult(
                success=False,
                message="You have uncommitted changes to tracked files. Please commit or stash them first.",
            )

    # Pull latest
    result = _run_git("pull", "origin", "main", "--ff-only", timeout=30)
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
    except Exception:
        pass  # Non-fatal — deps may already be up to date

    _clear_cache()

    return UpdateResult(
        success=True,
        message="Updated successfully. Restart Glooow to use the new version.",
        needs_restart=True,
    )
