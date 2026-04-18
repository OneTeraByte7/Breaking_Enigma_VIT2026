"""
Qanonym – Decoy Traffic Service

Every DECOY_INTERVAL_SECONDS seconds, injects a random blob that
looks like a real ciphertext into every active queue.

Clients receive decoys but silently discard them after a failed
decryption attempt (the REAL: prefix scheme handles this without
exposing the distinction on the wire).
"""

import asyncio
import secrets
import base64
import logging
from datetime import datetime, timezone

from app.core.config import settings
from app.core.store import store

logger = logging.getLogger("qanonym.decoy")


class DecoyTrafficService:

    @staticmethod
    async def run():
        """Main loop — runs forever as a background task."""
        logger.info(
            f"Decoy traffic service started "
            f"(interval={settings.DECOY_INTERVAL_SECONDS}s, "
            f"payload={settings.DECOY_PAYLOAD_BYTES}B)"
        )
        while True:
            await asyncio.sleep(settings.DECOY_INTERVAL_SECONDS)
            await DecoyTrafficService._inject_decoys()

    @staticmethod
    async def _inject_decoys():
        """Inject one decoy into every active, non-expired queue."""
        queue_ids = store.all_queue_ids()
        if not queue_ids:
            return

        decoy_bytes = secrets.token_bytes(settings.DECOY_PAYLOAD_BYTES)
        decoy_b64 = base64.b64encode(decoy_bytes).decode()

        decoy_msg = {
            "type": "message",
            "ciphertext": decoy_b64,
            "message_id": None,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "is_decoy": True,   # stripped before sending to WS, kept for internal routing
        }

        injected = 0
        for qid in queue_ids:
            if not store.queue_exists(qid):
                continue
            # Build a clean copy without internal flag for the wire
            wire_msg = {k: v for k, v in decoy_msg.items() if k != "is_decoy"}
            await store.push_message(qid, wire_msg, is_decoy=True)
            injected += 1

        if injected:
            logger.debug(f"Injected decoy traffic into {injected} queues.")