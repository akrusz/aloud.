"""Transcript logging for meditation sessions."""

import json
from datetime import datetime
from pathlib import Path
from typing import Any


class TranscriptLogger:
    """Logs session transcripts with timestamps.

    Saves transcripts in JSON format for easy parsing and review.
    """

    def __init__(
        self,
        save_directory: str | Path = "sessions",
        include_timestamps: bool = True,
    ):
        """Initialize transcript logger.

        Args:
            save_directory: Directory to save transcripts
            include_timestamps: Whether to include timestamps in output
        """
        self.save_directory = Path(save_directory)
        self.include_timestamps = include_timestamps

        # Ensure directory exists
        self.save_directory.mkdir(parents=True, exist_ok=True)

    def save_session(self, session_data: dict, session_id: str | None = None) -> Path:
        """Save a session transcript.

        Args:
            session_data: Session data from SessionManager.to_dict()
            session_id: Optional session ID (extracted from data if not provided)

        Returns:
            Path to the saved transcript file
        """
        if session_id is None:
            session_id = session_data.get("session_id", datetime.now().strftime("%Y-%m-%d-%H%M%S"))

        # Create filename
        filename = f"{session_id}.json"
        filepath = self.save_directory / filename

        # Add metadata
        output = {
            "version": "1.0",
            "saved_at": datetime.now().isoformat(),
            **session_data,
        }

        # Save as JSON
        with open(filepath, "w") as f:
            json.dump(output, f, indent=2, default=str)

        return filepath

    def save_session_text(self, session_data: dict, session_id: str | None = None) -> Path:
        """Save a session as human-readable text.

        Args:
            session_data: Session data from SessionManager.to_dict()
            session_id: Optional session ID

        Returns:
            Path to the saved text file
        """
        if session_id is None:
            session_id = session_data.get("session_id", datetime.now().strftime("%Y-%m-%d-%H%M%S"))

        filename = f"{session_id}.txt"
        filepath = self.save_directory / filename

        lines = []

        # Header
        lines.append("=" * 60)
        lines.append(f"Meditation Session: {session_id}")
        lines.append("=" * 60)
        lines.append("")

        # Metadata
        if session_data.get("start_time"):
            start = datetime.fromtimestamp(session_data["start_time"])
            lines.append(f"Started: {start.strftime('%Y-%m-%d %H:%M:%S')}")

        if session_data.get("duration"):
            duration = session_data["duration"]
            minutes = int(duration // 60)
            seconds = int(duration % 60)
            lines.append(f"Duration: {minutes}m {seconds}s")

        if session_data.get("tags"):
            lines.append(f"Tags: {', '.join(session_data['tags'])}")

        lines.append("")
        lines.append("-" * 60)
        lines.append("")

        # Transcript
        for exchange in session_data.get("exchanges", []):
            role = exchange["role"].capitalize()
            content = exchange["content"]

            if self.include_timestamps and "time" in exchange:
                timestamp = exchange["time"].split("T")[1].split(".")[0]  # HH:MM:SS
                lines.append(f"[{timestamp}] {role}:")
            else:
                lines.append(f"{role}:")

            lines.append(f"  {content}")
            lines.append("")

        # Notes
        if session_data.get("notes"):
            lines.append("-" * 60)
            lines.append("Notes:")
            lines.append(session_data["notes"])

        # Write file
        with open(filepath, "w") as f:
            f.write("\n".join(lines))

        return filepath

    def list_sessions(self) -> list[dict]:
        """List all saved sessions.

        Returns:
            List of session metadata (id, date, duration, exchange count)
        """
        sessions = []

        for filepath in sorted(self.save_directory.glob("*.json"), reverse=True):
            try:
                with open(filepath) as f:
                    data = json.load(f)

                sessions.append({
                    "session_id": data.get("session_id", filepath.stem),
                    "date": data.get("saved_at", "unknown"),
                    "duration": data.get("duration"),
                    "exchange_count": data.get("exchange_count"),
                    "tags": data.get("tags", []),
                    "summary": data.get("summary", ""),
                    "filepath": str(filepath),
                })
            except (json.JSONDecodeError, IOError):
                continue

        return sessions

    @staticmethod
    def _valid_session_id(session_id: str) -> bool:
        """Check that a session ID is safe for use as a filename."""
        import re
        return bool(re.match(r'^[a-zA-Z0-9_-]+$', session_id))

    def load_session(self, session_id: str) -> dict | None:
        """Load a saved session.

        Args:
            session_id: Session ID to load

        Returns:
            Session data, or None if not found
        """
        if not self._valid_session_id(session_id):
            return None

        filepath = self.save_directory / f"{session_id}.json"

        if not filepath.exists():
            return None

        with open(filepath) as f:
            return json.load(f)

    def delete_session(self, session_id: str) -> bool:
        """Delete a saved session.

        Args:
            session_id: Session ID to delete

        Returns:
            True if deleted, False if not found
        """
        if not self._valid_session_id(session_id):
            return False

        json_path = self.save_directory / f"{session_id}.json"
        txt_path = self.save_directory / f"{session_id}.txt"

        deleted = False

        if json_path.exists():
            json_path.unlink()
            deleted = True

        if txt_path.exists():
            txt_path.unlink()
            deleted = True

        return deleted


def format_duration(seconds: float) -> str:
    """Format duration as human-readable string.

    Args:
        seconds: Duration in seconds

    Returns:
        Formatted string like "5m 30s" or "1h 15m"
    """
    if seconds < 60:
        return f"{int(seconds)}s"
    elif seconds < 3600:
        minutes = int(seconds // 60)
        secs = int(seconds % 60)
        return f"{minutes}m {secs}s"
    else:
        hours = int(seconds // 3600)
        minutes = int((seconds % 3600) // 60)
        return f"{hours}h {minutes}m"
