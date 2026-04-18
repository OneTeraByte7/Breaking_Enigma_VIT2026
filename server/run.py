#!/usr/bin/env python3
"""
Run the Qanonym relay server.
Usage: python run.py [--reload]
"""

import sys
import uvicorn
from app.core.config import settings

if __name__ == "__main__":
    reload = "--reload" in sys.argv or settings.RELOAD
    uvicorn.run(
        "app.main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=reload,
        ws_ping_interval=20,
        ws_ping_timeout=20,
        log_level="info",
    )   