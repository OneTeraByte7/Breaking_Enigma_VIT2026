"""
Qanonym – WebSocket Subscription Endpoint

WS /ws/{queue_id}

Connection lifecycle:
  1. Client connects and subscribes to a queue.
  2. All buffered messages since connection are flushed immediately.
  3. New messages (real + decoy) are pushed as they arrive.
  4. On queue expiry, an {type: "expiry"} frame is sent, then the socket closes.
  5. Client pings every 30s; server responds with {type: "ping"}.
"""

import asyncio
import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status

from app.core.store import store

logger = logging.getLogger("qanonym.ws")
router = APIRouter()

PING_INTERVAL = 30  # seconds — client sends ping, server echoes


@router.websocket("/ws/{queue_id}")
async def websocket_subscribe(websocket: WebSocket, queue_id: str):
    """
    Subscribe to a queue over WebSocket.
    Receives all real messages, decoys, expiry warnings, and pings.
    """
    try:
        await websocket.accept()
    except Exception as e:
        logger.error(f"Failed to accept WebSocket connection for queue {queue_id[:8]}...: {e}")
        try:
            await websocket.close(code=1000)
        except:
            pass
        return
    
    logger.info(f"WebSocket connected to queue {queue_id[:8]}...")

    # If queue doesn't exist yet, create it (for peer joining scenario)
    if not store.queue_exists(queue_id):
        logger.info(f"Queue {queue_id[:8]}... doesn't exist yet; creating it.")
        await store.create_queue(queue_id)

    # Register subscriber
    sub_q = await store.add_subscriber(queue_id)

    # Flush already-buffered messages to this new subscriber
    state = store.get_queue(queue_id)
    if state:
        for msg in state.messages:
            try:
                await websocket.send_text(json.dumps(msg, default=str))
            except Exception:
                break

    try:
        while True:
            # Wait for next message from the queue OR client ping
            try:
                message = await asyncio.wait_for(sub_q.get(), timeout=PING_INTERVAL)
            except asyncio.TimeoutError:
                # Send keepalive ping
                try:
                    await websocket.send_json({
                        "type": "ping",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    })
                except Exception:
                    break
                continue

            # Handle expiry
            if message.get("type") in ("expiry", "expiry_warning"):
                try:
                    await websocket.send_text(json.dumps(message, default=str))
                except Exception:
                    pass
                if message.get("type") == "expiry":
                    logger.info(
                        f"Queue {queue_id[:8]}... expired; closing WebSocket."
                    )
                    await websocket.close(code=status.WS_1001_GOING_AWAY)
                    return
                continue

            # Forward message
            try:
                await websocket.send_text(json.dumps(message, default=str))
            except Exception:
                logger.debug(f"WebSocket send failed for queue {queue_id[:8]}...")
                break

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected from queue {queue_id[:8]}...")
    except Exception as e:
        logger.error(f"WebSocket error on queue {queue_id[:8]}...: {e}")
    finally:
        await store.remove_subscriber(queue_id, sub_q)
        logger.debug(f"Subscriber removed from queue {queue_id[:8]}...")