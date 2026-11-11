from fastapi import APIRouter

from app.config import settings

router = APIRouter()


@router.get("/api/health")
async def health() -> dict:
    return {
        "status": "ok",
        "service": "byteforge-api",
        "max_upload_bytes": settings.max_upload_bytes,
        "session_ttl_seconds": settings.session_ttl_seconds,
    }
