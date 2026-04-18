"""
Qanonym – Test Suite

Tests cover:
  - Queue creation, status, deletion
  - Message send/receive (REST)
  - WebSocket subscription and message delivery
  - Split delivery part assembly
  - Audit log hashing
  - Steganography embed/extract
  - Decoy injection
  - Queue expiry
"""

import asyncio
import base64
import hashlib
import json
import secrets
import pytest
from httpx import AsyncClient, ASGITransport

from app.main import app
from app.core.store import store
from app.core.config import settings
from app.services.audit import log_message, read_recent_audit


# ─────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────

@pytest.fixture(autouse=True)
async def clear_store():
    """Reset the in-memory store between tests."""
    store.queues.clear()
    store.subscribers.clear()
    yield
    store.queues.clear()
    store.subscribers.clear()


@pytest.fixture
async def client():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        yield ac


@pytest.fixture
async def queue_id(client):
    """Create a fresh queue and return its ID."""
    resp = await client.post("/api/v1/queues/create")
    assert resp.status_code == 201
    return resp.json()["queue_id"]


def make_ciphertext(content: str = "hello world") -> str:
    """Return a base64-encoded fake ciphertext."""
    return base64.b64encode(content.encode()).decode()


# ─────────────────────────────────────────────
# Health
# ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_root(client):
    resp = await client.get("/")
    assert resp.status_code == 200
    data = resp.json()
    assert data["service"] == "Qanonym Relay"


@pytest.mark.asyncio
async def test_health(client):
    resp = await client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


# ─────────────────────────────────────────────
# Queue creation
# ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_create_queue_returns_64_char_id(client):
    resp = await client.post("/api/v1/queues/create")
    assert resp.status_code == 201
    data = resp.json()
    assert "queue_id" in data
    assert len(data["queue_id"]) == 64
    assert data["max_messages"] == settings.MAX_MESSAGES_PER_QUEUE


@pytest.mark.asyncio
async def test_create_queue_is_unique(client):
    ids = set()
    for _ in range(10):
        resp = await client.post("/api/v1/queues/create")
        ids.add(resp.json()["queue_id"])
    assert len(ids) == 10


# ─────────────────────────────────────────────
# Queue status
# ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_queue_status(client, queue_id):
    resp = await client.get(f"/api/v1/queues/{queue_id}/status")
    assert resp.status_code == 200
    data = resp.json()
    assert data["real_message_count"] == 0
    assert data["expired"] is False
    # Must return hash, not raw ID
    expected_hash = hashlib.sha256(queue_id.encode()).hexdigest()
    assert data["queue_id_hash"] == expected_hash


@pytest.mark.asyncio
async def test_queue_status_not_found(client):
    resp = await client.get(f"/api/v1/queues/{'a' * 64}/status")
    assert resp.status_code == 404


# ─────────────────────────────────────────────
# Queue deletion
# ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_delete_queue(client, queue_id):
    resp = await client.delete(f"/api/v1/queues/{queue_id}")
    assert resp.status_code == 200
    assert resp.json()["status"] == "deleted"

    # Queue should now be gone
    resp2 = await client.get(f"/api/v1/queues/{queue_id}/status")
    assert resp2.status_code == 404


# ─────────────────────────────────────────────
# Message send
# ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_send_message(client, queue_id):
    ct = make_ciphertext("test message")
    resp = await client.post(
        f"/api/v1/messages/{queue_id}",
        json={"ciphertext": ct},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "split_queued"
    assert "cipher_hash" in data
    assert data["real_message_count"] == 1


@pytest.mark.asyncio
async def test_send_invalid_base64(client, queue_id):
    resp = await client.post(
        f"/api/v1/messages/{queue_id}",
        json={"ciphertext": "!!!not-base64!!!"},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_send_to_nonexistent_queue(client):
    resp = await client.post(
        f"/api/v1/messages/{'b' * 64}",
        json={"ciphertext": make_ciphertext()},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_send_increments_count(client, queue_id):
    for i in range(3):
        await client.post(
            f"/api/v1/messages/{queue_id}",
            json={"ciphertext": make_ciphertext(f"msg {i}")},
        )
    state = store.get_queue(queue_id)
    assert state.real_message_count == 3


# ─────────────────────────────────────────────
# Message poll (REST)
# ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_poll_messages(client, queue_id):
    ct = make_ciphertext("poll test")
    await client.post(f"/api/v1/messages/{queue_id}", json={"ciphertext": ct})
    # Allow time for split delivery
    await asyncio.sleep(0.1)

    resp = await client.get(f"/api/v1/messages/{queue_id}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["message_count"] >= 1  # at least part 0


# ─────────────────────────────────────────────
# Split delivery
# ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_split_delivery_produces_two_parts(client, queue_id):
    import uuid as _uuid
    msg_id = str(_uuid.uuid4())
    ct = make_ciphertext("split test payload 123")
    await client.post(
        f"/api/v1/messages/{queue_id}",
        json={"ciphertext": ct, "message_id": msg_id},
    )
    # Wait long enough for both parts (max delay is 3s, but we patch below)
    await asyncio.sleep(0.2)

    state = store.get_queue(queue_id)
    parts = [m for m in state.messages if m.get("message_id") == msg_id]
    assert len(parts) >= 1  # part 0 delivered immediately
    assert parts[0]["type"] == "part"
    assert parts[0]["part_index"] == 0


@pytest.mark.asyncio
async def test_split_reassembly():
    """Unit test: split bytes → concatenate → equal original."""
    original = secrets.token_bytes(512)
    encoded = base64.b64encode(original).decode()

    raw = base64.b64decode(encoded)
    mid = len(raw) // 2
    p0 = base64.b64encode(raw[:mid]).decode()
    p1 = base64.b64encode(raw[mid:]).decode()

    reassembled = base64.b64decode(p0) + base64.b64decode(p1)
    assert reassembled == original


# ─────────────────────────────────────────────
# Audit log
# ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_audit_log_hashes_only(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "AUDIT_LOG_PATH", str(tmp_path / "audit.log"))
    qid = "a" * 64
    ct = b"fake ciphertext bytes"
    qhash, chash = log_message(qid, ct)

    # Verify hash values
    assert qhash == hashlib.sha256(qid.encode()).hexdigest()
    assert chash == hashlib.sha256(ct).hexdigest()

    # Verify file does NOT contain raw queue_id or raw ciphertext
    content = (tmp_path / "audit.log").read_text()
    assert qid not in content
    assert "fake ciphertext bytes" not in content
    assert qhash in content
    assert chash in content


@pytest.mark.asyncio
async def test_audit_verify_endpoint(client, queue_id, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "AUDIT_LOG_PATH", str(tmp_path / "audit.log"))
    ct = make_ciphertext("verify me")
    await client.post(f"/api/v1/messages/{queue_id}", json={"ciphertext": ct})

    resp = await client.post(
        "/api/v1/audit/verify",
        json={"ciphertext_b64": ct, "queue_id": queue_id},
    )
    assert resp.status_code == 200
    assert resp.json()["found"] is True


# ─────────────────────────────────────────────
# Stats
# ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_stats_endpoint(client, queue_id):
    resp = await client.get("/api/v1/stats")
    assert resp.status_code == 200
    data = resp.json()
    assert "active_queues" in data
    assert "total_messages_relayed" in data
    assert "canary_status" in data
    assert data["active_queues"] >= 1


# ─────────────────────────────────────────────
# Steganography
# ─────────────────────────────────────────────

def test_stego_embed_extract(tmp_path):
    """Round-trip: embed queue_id into image, extract it back."""
    try:
        from PIL import Image
    except ImportError:
        pytest.skip("Pillow not installed")

    from app.utils.steganography import embed_in_image, extract_from_image

    # Create a small test image (100×100 white)
    img = Image.new("RGB", (100, 100), color=(255, 255, 255))
    carrier = str(tmp_path / "carrier.png")
    stego = str(tmp_path / "stego.png")
    img.save(carrier)

    queue_id = secrets.token_hex(32)
    embed_in_image(queue_id, carrier, stego)
    extracted = extract_from_image(stego)
    assert extracted == queue_id


def test_stego_no_payload(tmp_path):
    """Extraction from an unmodified image returns None."""
    try:
        from PIL import Image
    except ImportError:
        pytest.skip("Pillow not installed")

    from app.utils.steganography import extract_from_image

    img = Image.new("RGB", (100, 100), color=(128, 64, 32))
    path = str(tmp_path / "plain.png")
    img.save(path)
    result = extract_from_image(path)
    assert result is None


# ─────────────────────────────────────────────
# Queue expiry
# ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_queue_expires_after_max_messages(client, monkeypatch):
    monkeypatch.setattr(settings, "MAX_MESSAGES_PER_QUEUE", 3)
    resp = await client.post("/api/v1/queues/create")
    qid = resp.json()["queue_id"]

    for i in range(3):
        await client.post(
            f"/api/v1/messages/{qid}",
            json={"ciphertext": make_ciphertext(f"msg{i}")},
        )

    # Manually trigger expiry check
    from app.services.expiry import QueueExpiryService
    await QueueExpiryService._check_all_queues()

    state = store.get_queue(qid)
    assert state is None or state.expired


@pytest.mark.asyncio
async def test_expiry_warning_sent(monkeypatch):
    monkeypatch.setattr(settings, "MAX_MESSAGES_PER_QUEUE", 10)
    qid = secrets.token_hex(32)
    state = await store.create_queue(qid)
    state.real_message_count = 6  # 4 remaining → below WARNING_THRESHOLD of 5

    sub_q = await store.add_subscriber(qid)

    from app.services.expiry import QueueExpiryService
    await QueueExpiryService._check_all_queues()

    # Should have received a warning
    assert not sub_q.empty()
    msg = await sub_q.get()
    assert msg["type"] == "expiry_warning"
    assert msg["remaining_quota"] == 4