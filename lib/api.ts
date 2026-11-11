// Default: same-origin — the frontend host proxies /api/* to the backend
// (see next.config.js rewrites). Set NEXT_PUBLIC_BYTEFORGE_API_URL to call
// the backend directly, e.g. in production with a separate API domain.
export const API_URL = process.env.NEXT_PUBLIC_BYTEFORGE_API_URL || "";

export interface SessionInfo {
  session_id: string;
  filename: string;
  size: number;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body?.detail) detail = body.detail;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

export async function uploadFile(file: File): Promise<SessionInfo> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_URL}/api/sessions`, {
    method: "POST",
    body: form,
  });
  return handle<SessionInfo>(res);
}

export async function getSessionMeta(sessionId: string): Promise<SessionInfo> {
  const res = await fetch(`${API_URL}/api/sessions/${sessionId}`);
  return handle<SessionInfo>(res);
}

export async function readChunk(
  sessionId: string,
  offset: number,
  length: number
): Promise<Uint8Array> {
  const res = await fetch(
    `${API_URL}/api/sessions/${sessionId}/chunks?offset=${offset}&length=${length}`
  );
  await handle<Response>(res);
  return new Uint8Array(await res.arrayBuffer());
}

export async function writeBytes(
  sessionId: string,
  offset: number,
  bytes: number[]
): Promise<{ size: number }> {
  const res = await fetch(`${API_URL}/api/sessions/${sessionId}/bytes`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ offset, bytes }),
  });
  return handle<{ size: number }>(res);
}

export async function insertBytes(
  sessionId: string,
  offset: number,
  bytes: number[]
): Promise<{ size: number }> {
  const res = await fetch(`${API_URL}/api/sessions/${sessionId}/bytes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ offset, bytes }),
  });
  return handle<{ size: number }>(res);
}

export async function deleteBytes(
  sessionId: string,
  offset: number,
  length: number
): Promise<{ size: number }> {
  const res = await fetch(
    `${API_URL}/api/sessions/${sessionId}/bytes?offset=${offset}&length=${length}`,
    { method: "DELETE" }
  );
  return handle<{ size: number }>(res);
}

export async function discardSession(sessionId: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/sessions/${sessionId}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    throw new ApiError(res.status, res.statusText);
  }
}

export async function downloadFile(sessionId: string, filename: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/sessions/${sessionId}/download`);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body?.detail) detail = body.detail;
    } catch {
      // ignore
    }
    throw new ApiError(res.status, detail);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
