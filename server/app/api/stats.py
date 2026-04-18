"""
Qanonym – Stats & Audit Endpoints

GET /api/v1/stats        → relay stats + audit log tail + canary status
GET /api/v1/audit/verify → verify a specific ciphertext against the audit log
"""

import hashlib
import base64
import logging

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.core.store import store
from app.core.config import settings
from app.models.schemas import StatsResponse, AuditEntry
from app.services.audit import read_recent_audit, get_canary_status

logger = logging.getLogger("qanonym.stats")
router = APIRouter()


@router.get(
    "/stats",
    response_model=StatsResponse,
    summary="Relay statistics and audit log tail",
    description=(
        "Returns anonymized relay stats: active queue count, total messages relayed, "
        "recent audit log entries (hashes only), and canary status. "
        "No queue IDs, no IPs, no content is ever exposed here."
    ),
)
async def get_stats():
    active_queues = sum(
        1 for q in store.queues.values() if not q.expired
    )
    total_messages = sum(q.real_message_count for q in store.queues.values())

    canary = get_canary_status()
    raw_audit = read_recent_audit(n=5)
    audit_entries = [
        AuditEntry(
            timestamp=e["timestamp"],
            queue_id_hash=e["queue_id_hash"],
            cipher_hash=e["cipher_hash"],
        )
        for e in raw_audit
    ]

    return StatsResponse(
        active_queues=active_queues,
        total_messages_relayed=total_messages,
        canary_status=canary["status"],
        canary_last_updated=canary.get("last_updated"),
        recent_audit_entries=audit_entries,
    )


class VerifyRequest(BaseModel):
    ciphertext_b64: str
    queue_id: str


@router.post(
    "/audit/verify",
    summary="Verify a ciphertext appears in the audit log",
    description=(
        "Given a ciphertext (base64) and queue_id, computes their SHA-256 hashes "
        "and searches the audit log for a matching entry. "
        "This proves the relay handled this exact message without revealing the content."
    ),
)
async def verify_audit_entry(body: VerifyRequest):
    try:
        cipher_bytes = base64.b64decode(body.ciphertext_b64, validate=True)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 ciphertext.")

    cipher_hash = hashlib.sha256(cipher_bytes).hexdigest()
    queue_hash = hashlib.sha256(body.queue_id.encode()).hexdigest()

    import os
    log_path = settings.AUDIT_LOG_PATH
    if not os.path.exists(log_path):
        return {"found": False, "detail": "Audit log is empty."}

    with open(log_path) as f:
        for line in f:
            parts = line.strip().split(",")
            if len(parts) == 3:
                ts, qh, ch = parts
                if qh == queue_hash and ch == cipher_hash:
                    return {
                        "found": True,
                        "timestamp": ts,
                        "queue_id_hash": qh,
                        "cipher_hash": ch,
                    }

    return {"found": False, "detail": "No matching entry in audit log."}