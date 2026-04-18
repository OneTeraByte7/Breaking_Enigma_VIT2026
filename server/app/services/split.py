"""
Qanonym – Split Delivery Service

Splits a ciphertext into two roughly equal parts and delivers them
with a random delay between them, making traffic analysis harder.

An observer watching the wire sees two smaller packets with a time gap,
making it non-trivial to correlate them as a single message.

Client reassembly:
  - Part 0 is delivered immediately.
  - Part 1 is delivered after a random delay (0 – SPLIT_DELIVERY_MAX_DELAY seconds).
  - Both parts share the same message_id; the client buffers until both arrive.
"""

import asyncio
import secrets
import base64
import logging
from datetime import datetime, timezone

from app.core.config import settings
from app.core.store import store

logger = logging.getLogger("qanonym.split")


async def split_and_deliver(queue_id: str, ciphertext_b64: str, message_id: str):
    """
    Split ciphertext into two parts and push to the queue with a random delay.

    Part encoding: base64(part_bytes). The client concatenates part0 + part1,
    then base64-decodes to recover the original ciphertext bytes.
    """
    raw_bytes = base64.b64decode(ciphertext_b64)
    midpoint = len(raw_bytes) // 2

    part0_bytes = raw_bytes[:midpoint]
    part1_bytes = raw_bytes[midpoint:]

    part0_b64 = base64.b64encode(part0_bytes).decode()
    part1_b64 = base64.b64encode(part1_bytes).decode()

    ts = datetime.now(timezone.utc).isoformat()

    part0_msg = {
        "type": "part",
        "ciphertext": part0_b64,
        "message_id": message_id,
        "part_index": 0,
        "total_parts": 2,
        "timestamp": ts,
    }

    part1_msg = {
        "type": "part",
        "ciphertext": part1_b64,
        "message_id": message_id,
        "part_index": 1,
        "total_parts": 2,
        "timestamp": ts,
    }

    # Deliver part 0 immediately
    await store.push_message(queue_id, part0_msg, is_decoy=False)
    logger.debug(
        f"Split delivery: sent part 0/{len(part0_bytes)}B for msg {message_id[:8]}..."
    )

    # Schedule part 1 with random delay
    delay = secrets.SystemRandom().uniform(0, settings.SPLIT_DELIVERY_MAX_DELAY)
    asyncio.create_task(_delayed_part1(queue_id, part1_msg, delay, message_id))


async def _delayed_part1(queue_id: str, part1_msg: dict, delay: float, message_id: str):
    """Push part 1 after `delay` seconds."""
    await asyncio.sleep(delay)
    if store.queue_exists(queue_id):
        await store.push_message(queue_id, part1_msg, is_decoy=False)
        logger.debug(
            f"Split delivery: sent part 1 (delay={delay:.2f}s) "
            f"for msg {message_id[:8]}..."
        )
    else:
        logger.warning(
            f"Split delivery: queue {queue_id[:8]}... gone before part 1 "
            f"of msg {message_id[:8]}..."
        )