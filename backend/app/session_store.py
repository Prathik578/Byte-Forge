import threading
import time
import uuid
from typing import Optional

from app.config import settings

_DEFAULT_TTL = settings.session_ttl_seconds
_MAX_UPLOAD = settings.max_upload_bytes


class SessionNotFoundError(Exception):
    pass


class PayloadTooLargeError(Exception):
    pass


class BinarySession:
    def __init__(self, session_id: str, filename: str, data: bytearray) -> None:
        self.id = session_id
        self.filename = filename
        self.data = data
        self.created_at = time.time()
        self.last_accessed = self.created_at

    def touch(self) -> None:
        self.last_accessed = time.time()

    def size(self) -> int:
        return len(self.data)


class SessionStore:
    def __init__(self, ttl_seconds: int = _DEFAULT_TTL, max_bytes: int = _MAX_UPLOAD) -> None:
        self._sessions: dict[str, BinarySession] = {}
        self._lock = threading.Lock()
        self._ttl = ttl_seconds
        self._max_bytes = max_bytes

    def create(self, filename: str, data: bytearray) -> BinarySession:
        if self._max_bytes > 0 and len(data) > self._max_bytes:
            raise PayloadTooLargeError(f"File exceeds maximum allowed size of {self._max_bytes} bytes")
        session_id = uuid.uuid4().hex
        session = BinarySession(session_id, filename, data)
        with self._lock:
            self._sessions[session_id] = session
        return session

    def get(self, session_id: str) -> BinarySession:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                raise SessionNotFoundError("Session not found or expired")
            session.touch()
            return session

    def delete(self, session_id: str) -> None:
        with self._lock:
            self._sessions.pop(session_id, None)

    def cleanup(self) -> None:
        now = time.time()
        with self._lock:
            expired = [sid for sid, s in self._sessions.items() if now - s.last_accessed > self._ttl]
            for sid in expired:
                del self._sessions[sid]

    def count(self) -> int:
        with self._lock:
            return len(self._sessions)

    def total_bytes(self) -> int:
        with self._lock:
            return sum(s.size() for s in self._sessions.values())


store = SessionStore()
