import os


class Settings:
    def __init__(self) -> None:
        # Comma-separated list of allowed origins, or "*" for any.
        self.cors_origins: str = os.getenv("BYTEFORGE_CORS_ORIGINS", "*")
        # Maximum upload size in bytes; "0" disables the limit (not recommended).
        self.max_upload_bytes: int = int(os.getenv("BYTEFORGE_MAX_UPLOAD_BYTES", str(512 * 1024 * 1024)))
        # Seconds of inactivity before an uploaded file is discarded.
        self.session_ttl_seconds: int = int(os.getenv("BYTEFORGE_SESSION_TTL_SECONDS", "1800"))

    @property
    def cors_origins(self) -> str:
        return self._cors_origins

    @cors_origins.setter
    def cors_origins(self, value: str) -> None:
        self._cors_origins = value


settings = Settings()
