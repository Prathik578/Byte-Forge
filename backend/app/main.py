import logging

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routers import health, sessions

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("byteforge")


def _parse_origins(raw: str) -> list[str]:
    raw = raw.strip()
    if raw == "*":
        return ["*"]
    return [o.strip() for o in raw.split(",") if o.strip()]


app = FastAPI(
    title="ByteForge API",
    version="1.0.0",
    description="Stateless-ish REST API for inspecting and editing binary files in a browser.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_parse_origins(settings.cors_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)

app.include_router(health.router)
app.include_router(sessions.router)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(
        "ByteForge API starting: max_upload=%s ttl=%ss",
        settings.max_upload_bytes if settings.max_upload_bytes > 0 else "unlimited",
        settings.session_ttl_seconds,
    )
    yield


app.router.lifespan_context = lifespan


@app.middleware("http")
async def cleanup_expired_sessions(request, call_next):
    if request.method == "GET" and request.url.path == "/api/health":
        sessions.store.cleanup()
    return await call_next(request)
