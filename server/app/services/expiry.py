"""
Qanonym – Queue Expiry Service

Periodically checks all queues. When a queue's real_message_count
reaches MAX_MESSAGES_PER_QUEUE:
  1. Sends an expiry_warning to subscribers (with 5-message heads-up).
  2. Deletes the queue after the final message.

Clients receiving expiry_warning must generate a new queue_id and
re-share it with their peer (e.g., via a new steganographic QR).
"""

import asyncio
import logging

from app.core.config import settings
from app.core.store import store

logger = logging.getLogger("qanonym.expiry")

WARNING_THRESHOLD = 5  # Warn when this many messages remain


class QueueExpiryService:

    @staticmethod
    async def run():
        """Main loop — runs forever as a background task."""
        logger.info(
            f"Queue expiry service started "
            f"(check_interval={settings.QUEUE_EXPIRY_CHECK_INTERVAL}s, "
            f"max_messages={settings.MAX_MESSAGES_PER_QUEUE})"
        )
        while True:
            await asyncio.sleep(settings.QUEUE_EXPIRY_CHECK_INTERVAL)
            await QueueExpiryService._check_all_queues()

    @staticmethod
    async def _check_all_queues():
        """Evaluate every active queue for expiry or warning."""
        queue_ids = store.all_queue_ids()
        for qid in queue_ids:
            state = store.get_queue(qid)
            if state is None or state.expired:
                continue

            count = state.real_message_count
            limit = settings.MAX_MESSAGES_PER_QUEUE

            if count >= limit:
                # Hard expiry — delete the queue
                logger.info(
                    f"Queue {qid[:8]}... expired after {count} real messages. Deleting."
                )
                state.expired = True
                await store.delete_queue(qid)

            elif limit - count <= WARNING_THRESHOLD:
                # Soft warning — push a system message to subscribers
                remaining = limit - count
                warning_msg = {
                    "type": "expiry_warning",
                    "remaining_quota": remaining,
                    "message": (
                        f"Queue will expire after {remaining} more messages. "
                        "Generate a new queue ID and re-share with your peer."
                    ),
                }
                subs = store.subscribers.get(qid, [])
                for sub_q in subs:
                    await sub_q.put(warning_msg)
                logger.debug(
                    f"Sent expiry_warning to queue {qid[:8]}... "
                    f"({remaining} messages remaining)"
                )