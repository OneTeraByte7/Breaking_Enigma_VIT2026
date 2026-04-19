"""
Qanonym – Central In-Memory Store

Holds:
  - queues: dict[queue_id → QueueState]
  - subscribers: dict[queue_id → list[asyncio.Queue]]

Thread-safe via asyncio (single-threaded event loop). For multi-worker
deployments, replace with Redis pub/sub.
"""

import asyncio
from dataclasses import dataclass, field
from typing import Dict, List, Optional
from datetime import datetime, timezone


@dataclass
class QueueState:
    """State for a single queue."""
    queue_id: str
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    real_message_count: int = 0
    total_message_count: int = 0     # includes decoys
    messages: List[dict] = field(default_factory=list)
    expired: bool = False
    part_buffers: Dict[str, dict] = field(default_factory=dict)  # message_id → parts


class InMemoryStore:
    """
    Central store for all queue state.
    Subscribers are asyncio.Queue objects — each WS connection gets one.
    """

    def __init__(self):
        self.queues: Dict[str, QueueState] = {}
        # queue_id → list of asyncio.Queue (one per live WebSocket subscriber)
        self.subscribers: Dict[str, List[asyncio.Queue]] = {}
        self._lock = asyncio.Lock()

    async def create_queue(self, queue_id: str) -> QueueState:
        async with self._lock:
            state = QueueState(queue_id=queue_id)
            self.queues[queue_id] = state
            self.subscribers[queue_id] = []
            return state

    def get_queue(self, queue_id: str) -> Optional[QueueState]:
        return self.queues.get(queue_id)

    async def delete_queue(self, queue_id: str):
        async with self._lock:
            self.queues.pop(queue_id, None)
            # Notify all subscribers that this queue is gone
            subs = self.subscribers.pop(queue_id, [])
            for sub_q in subs:
                await sub_q.put({"type": "expiry", "queue_id": queue_id})

    async def add_subscriber(self, queue_id: str) -> asyncio.Queue:
        """Register a new WebSocket subscriber; returns its personal asyncio.Queue."""
        async with self._lock:
            sub_q: asyncio.Queue = asyncio.Queue()
            if queue_id not in self.subscribers:
                self.subscribers[queue_id] = []
            self.subscribers[queue_id].append(sub_q)
            return sub_q

    async def remove_subscriber(self, queue_id: str, sub_q: asyncio.Queue):
        async with self._lock:
            subs = self.subscribers.get(queue_id, [])
            if sub_q in subs:
                subs.remove(sub_q)

    async def push_message(self, queue_id: str, message: dict, is_decoy: bool = False):
        """
        Append a message to the queue and fan-out to all current subscribers.
        """
        async with self._lock:
            state = self.queues.get(queue_id)
            if state is None or state.expired:
                return

            # Persist a marker indicating whether this was a decoy so
            # later cleanup can adjust real/total counters correctly.
            message["_is_decoy"] = bool(is_decoy)
            state.messages.append(message)
            state.total_message_count += 1
            if not is_decoy:
                state.real_message_count += 1

            # Fan-out to all subscribers
            for sub_q in list(self.subscribers.get(queue_id, [])):
                await sub_q.put(message)

    def queue_exists(self, queue_id: str) -> bool:
        q = self.queues.get(queue_id)
        return q is not None and not q.expired

    def all_queue_ids(self) -> List[str]:
        return list(self.queues.keys())

    async def prune_expired_messages(self, queue_id: str):
        """Remove messages from a queue that have expired (by expires_at ISO timestamp).

        Adjust counters to remain consistent.
        """
        async with self._lock:
            state = self.queues.get(queue_id)
            if not state:
                return
            from datetime import datetime, timezone

            now = datetime.now(timezone.utc)
            new_messages = []
            for m in state.messages:
                expires = m.get("expires_at")
                if expires:
                    try:
                        exp_dt = datetime.fromisoformat(expires)
                    except Exception:
                        new_messages.append(m)
                        continue
                    if exp_dt <= now:
                        # Remove this message and adjust counters
                        state.total_message_count = max(0, state.total_message_count - 1)
                        if not m.get("_is_decoy", False):
                            state.real_message_count = max(0, state.real_message_count - 1)
                        # Notify subscribers that a message expired (if we have an id)
                        subs = list(self.subscribers.get(queue_id, []))
                        msg_id = m.get("message_id") or m.get("mid")
                        expiry_notice = {"type": "message_expired", "message_id": msg_id, "timestamp": now.isoformat(),}
                        for sub_q in subs:
                            # schedule put without awaiting to avoid deadlocks
                            try:
                                await sub_q.put(expiry_notice)
                            except Exception:
                                pass
                        continue
                new_messages.append(m)
            state.messages = new_messages


# Singleton — imported everywhere
store = InMemoryStore()