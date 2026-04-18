"""
Qanonym – Metadata-Resistant Messenger
Main FastAPI application entry point.
"""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import queues, messages, websocket, stats
from app.core.config import settings
from app.services.decoy import DecoyTrafficService
from app.services.expiry import QueueExpiryService
from app.core.store import store

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("qanonym")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown lifecycle manager."""
    logger.info("Starting Qanonym relay server...")

    # Start background services
    decoy_task = asyncio.create_task(DecoyTrafficService.run())
    expiry_task = asyncio.create_task(QueueExpiryService.run())

    logger.info("Background services started (decoy traffic + queue expiry).")
    yield

    # Cleanup on shutdown
    decoy_task.cancel()
    expiry_task.cancel()
    try:
        await decoy_task
        await expiry_task
    except asyncio.CancelledError:
        pass
    logger.info("Qanonym relay server shutdown complete.")


app = FastAPI(
    title="Qanonym Relay API",
    description=(
        "Blind relay server for Qanonym — a metadata-resistant messenger. "
        "The relay stores and forwards encrypted blobs only. "
        "It never sees plaintext content or user identities."
    ),
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
)

# CORS – allow all origins during dev; tighten in production
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount routers
app.include_router(queues.router, prefix="/api/v1", tags=["Queues"])
app.include_router(messages.router, prefix="/api/v1", tags=["Messages"])
app.include_router(websocket.router, tags=["WebSocket"])
app.include_router(stats.router, prefix="/api/v1", tags=["Stats & Audit"])


@app.get("/", tags=["Health"])
async def root():
    return {
        "service": "Qanonym Relay",
        "version": "1.0.0",
        "status": "operational",
        "note": "All stored data is encrypted ciphertext. No plaintext is ever processed.",
    }


@app.get("/health", tags=["Health"])
async def health():
    return {
        "status": "ok",
        "active_queues": len(store.queues),
    }


@app.exception_handler(404)
async def not_found_handler(request, exc):
    return JSONResponse(status_code=404, content={"detail": "Resource not found."})


@app.exception_handler(500)
async def server_error_handler(request, exc):
    logger.error(f"Internal server error: {exc}")
    return JSONResponse(status_code=500, content={"detail": "Internal server error."})