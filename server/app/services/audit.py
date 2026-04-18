"""
Qanonym – Audit Log Service

Logs SHA-256 hashes of queue IDs and ciphertexts.
The relay NEVER logs raw queue IDs, raw ciphertext, or IP addresses.

Log format (CSV):
  iso_timestamp,sha256(queue_id),sha256(ciphertext_bytes)

A Canary entry is appended daily:
  CANARY,iso_timestamp,sha256(server_secret+timestamp)
"""

import hashlib
import hmac
import secrets
import asyncio
import logging
from datetime import datetime, timezone
from pathlib import Path

from app.core.config import settings

logger = logging.getLogger("qanonym.audit")

# One-time server secret for canary signing (not persisted across restarts in demo)
_SERVER_SECRET = secrets.token_bytes(32)


def _hash(data: str | bytes) -> str:
    if isinstance(data, str):
        data = data.encode()
    return hashlib.sha256(data).hexdigest()


def _canary_signature(timestamp: str) -> str:
    return hmac.new(_SERVER_SECRET, timestamp.encode(), hashlib.sha256).hexdigest()


def log_message(queue_id: str, ciphertext_bytes: bytes) -> tuple[str, str]:
    """
    Append one audit entry. Returns (queue_hash, cipher_hash) for the response.
    """
    queue_hash = _hash(queue_id)
    cipher_hash = _hash(ciphertext_bytes)
    ts = datetime.now(timezone.utc).isoformat()
    entry = f"{ts},{queue_hash},{cipher_hash}\n"

    try:
        with open(settings.AUDIT_LOG_PATH, "a") as f:
            f.write(entry)
    except Exception as e:
        logger.error(f"Failed to write audit log: {e}")

    return queue_hash, cipher_hash


def log_canary():
    """Append a signed canary entry. Called daily by background task."""
    ts = datetime.now(timezone.utc).isoformat()
    sig = _canary_signature(ts)
    entry = f"CANARY,{ts},{sig}\n"

    try:
        with open(settings.CANARY_LOG_PATH, "a") as f:
            f.write(entry)
        logger.info(f"Canary entry written at {ts}")
    except Exception as e:
        logger.error(f"Failed to write canary: {e}")


def verify_canary(timestamp: str, signature: str) -> bool:
    """Verify a canary entry using the server secret."""
    expected = _canary_signature(timestamp)
    return hmac.compare_digest(expected, signature)


def read_recent_audit(n: int = 5) -> list[dict]:
    """Return the last n non-canary audit entries."""
    path = Path(settings.AUDIT_LOG_PATH)
    if not path.exists():
        return []
    try:
        lines = path.read_text().strip().splitlines()
        entries = []
        for line in reversed(lines):
            if line.startswith("CANARY"):
                continue
            parts = line.split(",")
            if len(parts) == 3:
                entries.append({
                    "timestamp": parts[0],
                    "queue_id_hash": parts[1],
                    "cipher_hash": parts[2],
                })
            if len(entries) >= n:
                break
        return entries
    except Exception as e:
        logger.error(f"Failed to read audit log: {e}")
        return []


def get_canary_status() -> dict:
    """Return the latest canary entry and its verification status."""
    path = Path(settings.CANARY_LOG_PATH)
    if not path.exists():
        return {"status": "no_canary", "last_updated": None}
    try:
        lines = [l for l in path.read_text().strip().splitlines() if l.startswith("CANARY")]
        if not lines:
            return {"status": "no_canary", "last_updated": None}
        last = lines[-1].split(",")
        ts, sig = last[1], last[2]
        valid = verify_canary(ts, sig)
        return {
            "status": "valid" if valid else "INVALID",
            "last_updated": ts,
        }
    except Exception as e:
        logger.error(f"Failed to read canary: {e}")
        return {"status": "error", "last_updated": None}


async def canary_writer_task():
    """Background task — writes a canary entry every CANARY_INTERVAL_HOURS."""
    interval = settings.CANARY_INTERVAL_HOURS * 3600
    while True:
        log_canary()
        await asyncio.sleep(interval)