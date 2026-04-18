"""
Qanonym – Queue API Endpoints

POST  /api/v1/queues/create   → create a new queue
GET   /api/v1/queues/{queue_id}/status  → queue status (hashed)
DELETE /api/v1/queues/{queue_id}        → manually expire a queue
POST  /api/v1/queues/{queue_id}/stego   → embed queue ID into an uploaded image
"""

import secrets
import hashlib
import io
import base64
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import StreamingResponse

from app.core.store import store
from app.core.config import settings
from app.models.schemas import CreateQueueResponse, QueueStatusResponse

router = APIRouter()


def _generate_queue_id() -> str:
    return secrets.token_hex(settings.QUEUE_ID_BYTES)   # 64-char hex string


@router.post(
    "/queues/create",
    response_model=CreateQueueResponse,
    summary="Create a new anonymous queue",
    description=(
        "Generates a cryptographically random queue ID. "
        "Share this ID with your peer out-of-band (ideally via steganographic QR). "
        "The relay does not record who created the queue or from where."
    ),
    status_code=201,
)
async def create_queue():
    if len(store.queues) >= settings.MAX_QUEUES_TOTAL:
        raise HTTPException(
            status_code=503,
            detail="Relay queue limit reached. Try again later.",
        )

    queue_id = _generate_queue_id()
    state = await store.create_queue(queue_id)

    return CreateQueueResponse(
        queue_id=queue_id,
        created_at=state.created_at,
        max_messages=settings.MAX_MESSAGES_PER_QUEUE,
    )


@router.get(
    "/queues/{queue_id}/status",
    response_model=QueueStatusResponse,
    summary="Get queue status (anonymized)",
    description=(
        "Returns anonymized status. The queue_id is hashed (SHA-256) in the response. "
        "Raw queue IDs are never logged or returned by the relay."
    ),
)
async def get_queue_status(queue_id: str):
    state = store.get_queue(queue_id)
    if state is None:
        raise HTTPException(status_code=404, detail="Queue not found.")

    return QueueStatusResponse(
        queue_id_hash=hashlib.sha256(queue_id.encode()).hexdigest(),
        real_message_count=state.real_message_count,
        total_message_count=state.total_message_count,
        created_at=state.created_at,
        expired=state.expired,
    )


@router.delete(
    "/queues/{queue_id}",
    summary="Manually expire (delete) a queue",
    description=(
        "Immediately marks the queue as expired and notifies all subscribers. "
        "Use this when transitioning to a new queue ID."
    ),
)
async def delete_queue(queue_id: str):
    state = store.get_queue(queue_id)
    if state is None:
        raise HTTPException(status_code=404, detail="Queue not found.")

    state.expired = True
    await store.delete_queue(queue_id)
    return {"status": "deleted", "queue_id_hash": hashlib.sha256(queue_id.encode()).hexdigest()}


@router.post(
    "/queues/{queue_id}/stego",
    summary="Embed queue ID into an image (steganography)",
    description=(
        "Upload a PNG or JPEG image. The server embeds the queue ID into the "
        "red-channel LSBs and returns the stego image as a PNG download. "
        "Share this image with your peer — they run the decoder to extract the queue ID."
    ),
)
async def embed_queue_id_in_image(
    queue_id: str,
    file: UploadFile = File(..., description="PNG or JPEG carrier image."),
):
    from app.utils.steganography import embed_in_image, PIL_AVAILABLE

    if not PIL_AVAILABLE:
        raise HTTPException(
            status_code=501,
            detail="Steganography requires Pillow. Install with: pip install Pillow",
        )

    if not store.queue_exists(queue_id):
        raise HTTPException(status_code=404, detail="Queue not found.")

    if file.content_type not in ("image/png", "image/jpeg"):
        raise HTTPException(status_code=400, detail="Only PNG and JPEG images are supported.")

    image_bytes = await file.read()

    import tempfile, os
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as inp:
        inp.write(image_bytes)
        inp_path = inp.name

    out_path = inp_path + "_stego.png"

    try:
        embed_in_image(queue_id, inp_path, out_path)
        with open(out_path, "rb") as f:
            result = f.read()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        os.unlink(inp_path)
        if os.path.exists(out_path):
            os.unlink(out_path)

    return StreamingResponse(
        io.BytesIO(result),
        media_type="image/png",
        headers={"Content-Disposition": "attachment; filename=share_this.png"},
    )


@router.post(
    "/queues/stego/extract",
    summary="Extract queue ID from a stego image",
    description="Upload a stego image produced by the /stego endpoint to recover the queue ID.",
)
async def extract_queue_id_from_image(
    file: UploadFile = File(..., description="Stego PNG image."),
):
    from app.utils.steganography import extract_from_image, PIL_AVAILABLE

    if not PIL_AVAILABLE:
        raise HTTPException(status_code=501, detail="Steganography requires Pillow.")

    image_bytes = await file.read()

    import tempfile, os
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as inp:
        inp.write(image_bytes)
        inp_path = inp.name

    try:
        queue_id = extract_from_image(inp_path)
    finally:
        os.unlink(inp_path)

    if queue_id is None:
        raise HTTPException(status_code=404, detail="No Qanonym payload found in this image.")

    return {"queue_id": queue_id}