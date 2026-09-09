/** Admin console API client — token from localStorage (admin login). */
const BASE = (import.meta as { env?: { VITE_API?: string } }).env?.VITE_API ?? '';

export interface LoginResponse {
  tokens: { accessToken: string; refreshToken: string };
  role: string;
  mustChangePassword: boolean;
}

export const TOKEN_KEY = 'laboflow.admin.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new CustomEvent('laboflow:unauthorized'));
    throw new Error('未登录或令牌过期');
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => ({ message: res.statusText }))) as { message?: string };
    throw new Error(err.message ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}
