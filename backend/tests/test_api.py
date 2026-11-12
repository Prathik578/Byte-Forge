import io

import pytest
from fastapi.testclient import TestClient

from app.config import DEFAULT_MAX_UPLOAD_BYTES, Settings
from app.main import app
from app.session_store import store


@pytest.fixture()
def client():
    return TestClient(app)


def _upload(client, data: bytes, filename="test.bin"):
    return client.post(
        "/api/sessions",
        files={"file": (filename, io.BytesIO(data), "application/octet-stream")},
    )


def test_default_upload_limit(monkeypatch):
    monkeypatch.delenv("BYTEFORGE_MAX_UPLOAD_BYTES", raising=False)
    assert Settings().max_upload_bytes == DEFAULT_MAX_UPLOAD_BYTES == 800 * 1024 * 1024


def test_upload_size_limit(client, monkeypatch):
    monkeypatch.setattr(store, "_max_bytes", 4)
    response = _upload(client, b"12345")
    assert response.status_code == 413
    assert response.json()["detail"] == "File too large"


def test_health(client):
    res = client.get("/api/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["service"] == "byteforge-api"
    assert body["max_upload_bytes"] == store._max_bytes


def test_upload_and_meta(client):
    res = _upload(client, b"\x00\x01\x02\x03")
    assert res.status_code == 200
    sid = res.json()["session_id"]
    assert res.json()["size"] == 4

    meta = client.get(f"/api/sessions/{sid}")
    assert meta.status_code == 200
    assert meta.json()["filename"] == "test.bin"


def test_read_chunk(client):
    data = bytes(range(256)) * 4
    sid = _upload(client, data).json()["session_id"]

    res = client.get(f"/api/sessions/{sid}/chunks", params={"offset": 0, "length": 16})
    assert res.status_code == 200
    assert res.content == bytes(range(16))
    assert res.headers["X-Chunk-Length"] == "16"

    res = client.get(f"/api/sessions/{sid}/chunks", params={"offset": 1000, "length": 16})
    assert res.status_code == 200
    assert res.content == data[1000:1016]


def test_write_bytes(client):
    sid = _upload(client, b"AAAAA").json()["session_id"]
    res = client.patch(f"/api/sessions/{sid}/bytes", json={"offset": 1, "bytes": [66, 67]})
    assert res.status_code == 200
    dl = client.get(f"/api/sessions/{sid}/download")
    assert dl.content == b"ABC" + b"AA"


def test_write_past_end_rejected(client):
    sid = _upload(client, b"AAA").json()["session_id"]
    res = client.patch(f"/api/sessions/{sid}/bytes", json={"offset": 2, "bytes": [1, 2, 3]})
    assert res.status_code == 400


def test_insert_bytes(client):
    sid = _upload(client, b"AAA").json()["session_id"]
    res = client.post(f"/api/sessions/{sid}/bytes", json={"offset": 1, "bytes": [88, 89]})
    assert res.status_code == 200
    dl = client.get(f"/api/sessions/{sid}/download")
    assert dl.content == b"AXYAA"


def test_delete_bytes(client):
    sid = _upload(client, b"AXYB").json()["session_id"]
    res = client.delete(f"/api/sessions/{sid}/bytes", params={"offset": 1, "length": 2})
    assert res.status_code == 200
    dl = client.get(f"/api/sessions/{sid}/download")
    assert dl.content == b"AB"


def test_download_disposition(client):
    sid = _upload(client, b"data", filename="hello.bin").json()["session_id"]
    res = client.get(f"/api/sessions/{sid}/download")
    assert res.headers["Content-Disposition"] == 'attachment; filename="hello.bin"'
    assert res.content == b"data"


def test_delete_session(client):
    sid = _upload(client, b"data").json()["session_id"]
    assert client.delete(f"/api/sessions/{sid}").status_code == 200
    assert client.get(f"/api/sessions/{sid}").status_code == 404


def test_unknown_session_404(client):
    assert client.get("/api/sessions/nonexistent").status_code == 404


def test_empty_file_rejected(client):
    res = _upload(client, b"")
    assert res.status_code == 400


def test_invalid_byte_value_rejected(client):
    sid = _upload(client, b"AAA").json()["session_id"]
    res = client.patch(f"/api/sessions/{sid}/bytes", json={"offset": 0, "bytes": [256]})
    assert res.status_code == 400


def test_offset_out_of_range_rejected(client):
    sid = _upload(client, b"AAA").json()["session_id"]
    res = client.get(f"/api/sessions/{sid}/chunks", params={"offset": 10})
    assert res.status_code == 400
