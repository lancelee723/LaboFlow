const BASE = import.meta.env.BASE_URL.replace(/\/$/, "")

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const url = path.startsWith("/") ? `${BASE}${path}` : path
  const res = await fetch(url, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail || `HTTP ${res.status}`)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

export interface ResumeResponse {
  answer?: string | string[] | number
  answers?: Record<string, unknown>
  page_count_change?: number
}

export async function resumeSession(
  sessionId: string | null,
  response: ResumeResponse,
): Promise<void> {
  if (!sessionId) throw new Error("No active session")
  await apiFetch<void>("/api/orchestrate/resume", {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId, response }),
  })
}
