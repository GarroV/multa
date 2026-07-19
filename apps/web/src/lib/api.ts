const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly body: unknown,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

/** Обёртка над fetch к API. credentials include — сессия из httpOnly-cookie. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const code = (body as { error?: string } | null)?.error ?? `http_${res.status}`;
    throw new ApiError(res.status, code, body);
  }
  return body as T;
}
