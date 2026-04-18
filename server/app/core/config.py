"""
Qanonym – Configuration Settings
All tuneable parameters in one place.
"""

import secrets
from typing import List
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Server
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    RELOAD: bool = False

    # CORS
    ALLOWED_ORIGINS: List[str] = [
        "http://localhost:5173",
        "http://localhost:3000",
        "http://localhost:5174",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:3000"
    ]

    # Queue settings
    QUEUE_ID_BYTES: int = 32          # 32 random bytes → 64-char hex queue ID
    MAX_MESSAGES_PER_QUEUE: int = 50  # Auto-expire after this many real messages
    QUEUE_EXPIRY_CHECK_INTERVAL: int = 30  # seconds between expiry sweeps

    # Decoy traffic
    DECOY_INTERVAL_SECONDS: float = 5.0   # How often fake messages are injected
    DECOY_PAYLOAD_BYTES: int = 256        # Size of each decoy blob
    DECOY_MAGIC_PREFIX: str = "REAL:"     # Real messages are prefixed with this before base64
    # NOTE: The prefix is applied BEFORE encryption on the client side.
    # The relay never sees it — it's just a convention agreed between clients.

    # Split delivery
    SPLIT_DELIVERY_MAX_DELAY: float = 3.0   # Max seconds between part1 and part2

    # Audit log
    AUDIT_LOG_PATH: str = "audit.log"
    CANARY_LOG_PATH: str = "canary.log"
    CANARY_INTERVAL_HOURS: int = 24

    # Rate limiting (simple)
    MAX_QUEUES_TOTAL: int = 10_000
    MAX_CIPHERTEXT_BYTES: int = 10 * 1024 * 1024  # 10 MB per message

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()