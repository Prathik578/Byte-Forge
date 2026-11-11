import json
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.session_store import (
    PayloadTooLargeError,
    SessionNotFoundError,
    store,
)

router = APIRouter(prefix="/api/sessions")

DEFAULT_CHUNK_SIZE = 4096
MAX_CHUNK_SIZE = 65536


class WriteRequest(BaseModel):
    offset: int = Field(ge=0)
    # List of byte values 0-255 to write at the offset.
    bytes: list[int] = Field(min_length=1, max_length=MAX_CHUNK_SIZE)


class InsertRequest(WriteRequest):
    pass


def _get_session(session_id: str):
    try:
        return store.get(session_id)
    except SessionNotFoundError:
        raise HTTPException(status_code=404, detail="Session not found or expired")


def _validate_offset(session, offset: int) -> None:
    if offset < 0 or offset > session.size():
        raise HTTPException(status_code=400, detail="Offset out of range")


@router.post("")
async def create_session(
    response: Response,
    file: UploadFile = File(...),
):
    data = bytearray()
    chunk_size = 1024 * 1024
    try:
        while True:
            chunk = await file.read(chunk_size)
            if not chunk:
                break
            data.extend(chunk)
            if store._max_bytes > 0 and len(data) > store._max_bytes:
                raise PayloadTooLargeError()
    except PayloadTooLargeError:
        raise HTTPException(status_code=413, detail="File too large")
    finally:
        await file.close()

    if len(data) == 0:
        raise HTTPException(status_code=400, detail="Empty file")

    filename = file.filename or "untitled.bin"
    session = store.create(filename, data)
    response.headers["Location"] = f"/api/sessions/{session.id}"
    return {
        "session_id": session.id,
        "filename": session.filename,
        "size": session.size(),
    }


@router.get("/{session_id}")
async def get_session_meta(session_id: str):
    session = _get_session(session_id)
    return {
        "session_id": session.id,
        "filename": session.filename,
        "size": session.size(),
    }


@router.get("/{session_id}/chunks")
async def read_chunk(
    session_id: str,
    offset: int = 0,
    length: int = DEFAULT_CHUNK_SIZE,
):
    session = _get_session(session_id)
    _validate_offset(session, offset)
    if length < 1:
        raise HTTPException(status_code=400, detail="length must be >= 1")
    length = min(length, MAX_CHUNK_SIZE)
    chunk = bytes(session.data[offset : offset + length])
    return Response(
        content=chunk,
        media_type="application/octet-stream",
        headers={"X-Chunk-Offset": str(offset), "X-Chunk-Length": str(len(chunk))},
    )


@router.patch("/{session_id}/bytes")
async def write_bytes(session_id: str, body: WriteRequest):
    session = _get_session(session_id)
    _validate_offset(session, body.offset)
    end = body.offset + len(body.bytes)
    if end > session.size():
        raise HTTPException(status_code=400, detail="Write extends past end of file")
    for i, b in enumerate(body.bytes):
        if b < 0 or b > 255:
            raise HTTPException(status_code=400, detail="Byte values must be 0-255")
    session.data[body.offset : end] = bytes(body.bytes)
    return {"session_id": session.id, "size": session.size()}


@router.post("/{session_id}/bytes")
async def insert_bytes(session_id: str, body: InsertRequest):
    session = _get_session(session_id)
    _validate_offset(session, body.offset)
    if store._max_bytes > 0 and session.size() + len(body.bytes) > store._max_bytes:
        raise HTTPException(status_code=413, detail="Resulting file would exceed maximum size")
    for i, b in enumerate(body.bytes):
        if b < 0 or b > 255:
            raise HTTPException(status_code=400, detail="Byte values must be 0-255")
    session.data[body.offset : body.offset] = bytes(body.bytes)
    return {"session_id": session.id, "size": session.size()}


@router.delete("/{session_id}/bytes")
async def delete_bytes(
    session_id: str,
    offset: int = 0,
    length: int = 0,
):
    session = _get_session(session_id)
    _validate_offset(session, offset)
    if length < 1:
        raise HTTPException(status_code=400, detail="length must be >= 1")
    if offset + length > session.size():
        raise HTTPException(status_code=400, detail="Delete range extends past end of file")
    del session.data[offset : offset + length]
    return {"session_id": session.id, "size": session.size()}


@router.get("/{session_id}/download")
async def download(session_id: str):
    session = _get_session(session_id)
    data = bytes(session.data)
    filename = session.filename
    session.touch()

    import io

    buffer = io.BytesIO(data)
    return StreamingResponse(
        buffer,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(len(data)),
        },
    )


@router.delete("/{session_id}")
async def discard(session_id: str):
    store.delete(session_id)
    return {"status": "discarded"}
