"""Self-signed certificate generation for LAN HTTPS."""

import logging
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)


def ensure_cert(cert_dir: Path, local_ip: str) -> tuple[str, str] | None:
    """Return (cert_path, key_path), generating a self-signed cert if needed.

    Returns None if generation fails (e.g. openssl not installed).
    """
    cert_path = cert_dir / "server.crt"
    key_path = cert_dir / "server.key"

    if cert_path.exists() and key_path.exists():
        return str(cert_path), str(key_path)

    cert_dir.mkdir(parents=True, exist_ok=True)

    san = f"IP:{local_ip},IP:127.0.0.1,DNS:localhost"

    try:
        subprocess.run(
            [
                "openssl", "req", "-x509", "-newkey", "rsa:2048",
                "-keyout", str(key_path), "-out", str(cert_path),
                "-days", "365", "-nodes",
                "-subj", "/CN=glooow",
                "-addext", f"subjectAltName={san}",
            ],
            check=True,
            capture_output=True,
        )
        logger.info("Generated self-signed cert for LAN HTTPS (%s)", cert_path)
        return str(cert_path), str(key_path)
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        logger.warning("Could not generate self-signed cert: %s", e)
        return None
