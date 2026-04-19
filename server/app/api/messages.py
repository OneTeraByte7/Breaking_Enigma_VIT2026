"""
Qanonym – Message API Endpoints

POST /api/v1/messages/{queue_id}  → send encrypted message to a queue
GET  /api/v1/messages/{queue_id}  → poll for pending messages (fallback to WS)
"""

import base64
import hashlib
import uuid
import secrets
import logging
from datetime import datetime, timezone
from datetime import timedelta

from fastapi import APIRouter, HTTPException, Query

from app.core.store import store
from app.core.config import settings
from app.models.schemas import SendMessageRequest, SendMessageResponse
from app.services.audit import log_message
from app.services.split import split_and_deliver

logger = logging.getLogger("qanonym.messages")
router = APIRouter()


@router.post(
    "/messages/{queue_id}",
    response_model=SendMessageResponse,
    summary="Send an encrypted message to a queue",
    description=(
        "Accepts a base64-encoded ciphertext blob. The relay stores it opaquely "
        "and fans it out to all current WebSocket subscribers. "
        "Messages are automatically split into two parts for traffic analysis resistance "
        "(split delivery / poor man's mix). "
        "The relay logs only SHA-256 hashes, never raw content."
    ),
)
async def send_message(queue_id: str, body: SendMessageRequest):
    if not store.queue_exists(queue_id):
        raise HTTPException(status_code=404, detail="Queue not found or expired.")

    state = store.get_queue(queue_id)
    remaining = settings.MAX_MESSAGES_PER_QUEUE - state.real_message_count
    if remaining <= 0:
        raise HTTPException(
            status_code=410,
            detail="Queue has reached its message limit and has been expired.",
        )

    # Decode to validate and get raw bytes for hashing
    try:
        ciphertext_bytes = base64.b64decode(body.ciphertext, validate=True)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 ciphertext.")

    # Audit log (hashes only)
    queue_hash, cipher_hash = log_message(queue_id, ciphertext_bytes)

    # Determine message_id for split delivery
    if getattr(body, "message_id", None):
        message_id = body.message_id
        mid_sha = hashlib.sha256(message_id.encode()).hexdigest()
        logger.info(
            f"Message id provided by client (sha256={mid_sha[:12]}...), will be used as-is"
        )
        mid_generation = "client_provided"
    else:
        # Use OS-backed CSPRNG for server-generated ids
        message_id = secrets.token_hex(16)
        mid_sha = hashlib.sha256(message_id.encode()).hexdigest()
        logger.info(
            f"Message id generated server-side via secrets.token_hex (CSPRNG, bytes=16) sha256={mid_sha[:12]}..."
        )
        mid_generation = "server_csprng"

    # Optional per-message expiry
    expires_at_iso = None
    if getattr(body, "self_destruct_seconds", None):
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=body.self_destruct_seconds)
        expires_at_iso = expires_at.isoformat()

    # Split delivery (async — part 1 delayed, part 2 scheduled)
    await split_and_deliver(queue_id, body.ciphertext, message_id, expires_at_iso=expires_at_iso)

    # Refresh state after potential mutation
    state = store.get_queue(queue_id)
    new_remaining = settings.MAX_MESSAGES_PER_QUEUE - state.real_message_count if state else 0
    expiry_warning = new_remaining <= 5

    logger.info(
        f"Message relayed to queue {queue_id[:8]}... "
        f"({state.real_message_count}/{settings.MAX_MESSAGES_PER_QUEUE} real messages)"
    )

    return SendMessageResponse(
        status="split_queued",
        queue_id_hash=queue_hash,
        cipher_hash=cipher_hash,
        real_message_count=state.real_message_count if state else 0,
        expiry_warning=expiry_warning,
    )


@router.get(
    "/messages/{queue_id}",
    summary="Poll for pending messages (REST fallback)",
    description=(
        "Returns all messages currently buffered in the queue. "
        "Prefer the WebSocket endpoint for real-time delivery. "
        "Messages are NOT deleted after retrieval in this endpoint — "
        "use WebSocket subscription for proper one-time delivery."
    ),
)
async def poll_messages(
    queue_id: str,
    limit: int = Query(default=20, ge=1, le=100, description="Max messages to return."),
):
    state = store.get_queue(queue_id)
    if state is None:
        raise HTTPException(status_code=404, detail="Queue not found or expired.")

    messages = state.messages[-limit:]
    return {
        "queue_id_hash": hashlib.sha256(queue_id.encode()).hexdigest(),
        "message_count": len(messages),
        "messages": messages,
    }