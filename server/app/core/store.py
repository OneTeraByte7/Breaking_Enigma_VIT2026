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
from datetime import datetime


@dataclass
class QueueState:
    """State for a single queue."""
    queue_id: str
    created_at: datetime = field(default_factory=datetime.utcnow)
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


# Singleton — imported everywhere
store = InMemoryStore()