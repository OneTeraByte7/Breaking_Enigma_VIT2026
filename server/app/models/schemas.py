"""
Qanonym – Pydantic Models
Request bodies, response schemas, and internal message types.
"""

from pydantic import BaseModel, Field, field_validator
from typing import Optional, Literal
from datetime import datetime
import base64
from datetime import timezone


# ─────────────────────────────────────────────
# Queue models
# ─────────────────────────────────────────────

class CreateQueueResponse(BaseModel):
    queue_id: str = Field(..., description="64-char hex queue identifier.")
    created_at: datetime
    max_messages: int = Field(..., description="Queue auto-expires after this many real messages.")

    model_config = {"json_schema_extra": {
        "example": {
            "queue_id": "a3f1...hex64chars",
            "created_at": "2024-01-01T00:00:00Z",
            "max_messages": 50,
        }
    }}


class QueueStatusResponse(BaseModel):
    queue_id_hash: str = Field(..., description="SHA-256 of queue_id (never the raw ID).")
    real_message_count: int
    total_message_count: int
    created_at: datetime
    expired: bool


# ─────────────────────────────────────────────
# Message models
# ─────────────────────────────────────────────

class SendMessageRequest(BaseModel):
    """
    Clients POST an encrypted blob as base64.
    The relay never decrypts; it forwards opaque bytes verbatim.
    """
    ciphertext: str = Field(
        ...,
        description=(
            "Base64-encoded encrypted message payload. "
            "Encrypted client-side with XSalsa20-Poly1305 (libsodium secretbox). "
            "Max decoded size: 10 MB."
        ),
    )
    message_id: Optional[str] = Field(
        None,
        description="Optional client-generated UUID for split delivery reassembly.",
    )
    self_destruct_seconds: Optional[int] = Field(
        None,
        description="Optional: number of seconds after which this message should be destroyed.",
        ge=1,
    )

    @field_validator("ciphertext")
    @classmethod
    def validate_base64(cls, v: str) -> str:
        try:
            decoded = base64.b64decode(v, validate=True)
        except Exception:
            raise ValueError("ciphertext must be valid base64.")
        if len(decoded) > 10 * 1024 * 1024:
            raise ValueError("ciphertext exceeds maximum size of 10 MB.")
        return v


class SendMessageResponse(BaseModel):
    status: Literal["queued", "split_queued"]
    queue_id_hash: str
    cipher_hash: str = Field(..., description="SHA-256 of the raw ciphertext bytes (for audit).")
    real_message_count: int
    expiry_warning: bool = Field(
        False,
        description="True when remaining message quota is ≤ 5.",
    )


# ─────────────────────────────────────────────
# WebSocket message envelope
# ─────────────────────────────────────────────

class WireMessage(BaseModel):
    """
    Every message pushed over WebSocket uses this envelope.
    Clients identify real vs decoy by attempting decryption.
    """
    type: Literal["message", "part", "expiry_warning", "expiry", "ping"] = "message"
    ciphertext: Optional[str] = None       # base64, present for type=message|part
    message_id: Optional[str] = None       # present for type=part
    part_index: Optional[int] = None       # 0 or 1, for split delivery
    total_parts: Optional[int] = None      # always 2 for split delivery
    timestamp: Optional[datetime] = None
    remaining_quota: Optional[int] = None  # for expiry_warning
    expires_at: Optional[datetime] = None


# ─────────────────────────────────────────────
# Audit / stats models
# ─────────────────────────────────────────────

class AuditEntry(BaseModel):
    timestamp: str
    queue_id_hash: str
    cipher_hash: str


class StatsResponse(BaseModel):
    active_queues: int
    total_messages_relayed: int
    canary_status: str
    canary_last_updated: Optional[str]
    recent_audit_entries: list[AuditEntry]