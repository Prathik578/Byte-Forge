# ByteForge

A browser-based binary (hex) editor. Upload any file, inspect its bytes in a
virtualized hex grid, patch individual bytes in hex, and download the modified
file. Files are processed in server memory only and expire automatically —
nothing is written to disk.

## Architecture

| Piece    | Tech                 | Deploy target                    |
| -------- | -------------------- | -------------------------------- |
| Frontend | Next.js + TypeScript + Tailwind | Vercel (or Netlify)   |
| Backend  | Python FastAPI       | Render, Railway, Fly.io, any Python host |

The frontend talks to the backend over REST. The backend holds uploaded files
in process memory with a TTL; the frontend requests only the byte ranges it
needs (4096-byte chunks) so even multi-hundred-MB files scroll smoothly.

## Project layout

```
app/, components/, lib/     Next.js frontend
  lib/api.ts                API client (uses NEXT_PUBLIC_BYTEFORGE_API_URL)
  components/hex-editor.tsx Virtualized hex grid + editing panel
backend/
  app/main.py               FastAPI app, CORS, health-check wiring
  app/routers/sessions.py   Upload, chunk read, write/insert/delete, download
  app/session_store.py      In-memory session store with TTL cleanup
  tests/                    pytest suite (13 tests)
```

## API endpoints

| Method | Path                          | Purpose                              |
| ------ | ----------------------------- | ------------------------------------ |
| GET    | `/api/health`                 | Health check / service info          |
| POST   | `/api/sessions`               | Upload a file (multipart), returns session id |
| GET    | `/api/sessions/{id}`          | Session metadata (filename, size)    |
| GET    | `/api/sessions/{id}/chunks?offset&length` | Read up to 65536 bytes    |
| PATCH  | `/api/sessions/{id}/bytes`    | Overwrite bytes at an offset         |
| POST   | `/api/sessions/{id}/bytes`    | Insert bytes at an offset            |
| DELETE | `/api/sessions/{id}/bytes?offset&length`  | Delete a byte range       |
| GET    | `/api/sessions/{id}/download` | Download the (possibly modified) file |
| DELETE | `/api/sessions/{id}`          | Discard the session immediately      |

## Local development

Frontend:

```bash
npm install
cp .env.example .env.local   # point NEXT_PUBLIC_BYTEFORGE_API_URL at the API
npm run dev
```

Backend:

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000
```

Backend tests:

```bash
cd backend && .venv/bin/python -m pytest tests/ -q
```

## Deploying the backend (Render example)

1. Push this repository to GitHub.
2. In Render, create a new **Web Service** pointing at the repo.
3. Set:
   - **Runtime:** Python 3
   - **Root directory:** `backend`
   - **Build command:** `pip install -r requirements.txt`
   - **Start command:** `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
4. Add environment variables (from `backend/.env.example`):
   - `BYTEFORGE_CORS_ORIGINS=https://your-frontend.vercel.app`
   - `BYTEFORGE_MAX_UPLOAD_BYTES=536870912`
   - `BYTEFORGE_SESSION_TTL_SECONDS=1800`
5. Health-check path: `/api/health`.
6. Deploy and note the service URL, e.g. `https://byteforge-api.onrender.com`.

Railway works the same way: root directory `backend`, start command
`uvicorn app.main:app --host 0.0.0.0 --port $PORT`.

## Deploying the frontend (Vercel)

1. In Vercel, import the repository.
2. Framework preset: **Next.js** (defaults are fine — build is `npm run build`).
3. Add the environment variable:
   - `NEXT_PUBLIC_BYTEFORGE_API_URL=https://byteforge-api.onrender.com`
     (your backend URL from the previous section, no trailing slash)
4. Deploy.

Then open the site, set CORS on the backend to the deployed frontend URL, and
redeploy the backend if you changed its environment variables.

## Security notes

- Uploaded files are **never executed** — only byte-level reads/writes.
- No files touch disk; everything lives in memory and expires after the TTL
  (30 minutes of inactivity by default) or when the user closes the session.
- Upload size is capped (`BYTEFORGE_MAX_UPLOAD_BYTES`); offsets and lengths are
  validated server-side; byte values must be 0–255.
- CORS is configurable and should be locked to the frontend origin in
  production. No secrets are used by the frontend — only the public API URL.
