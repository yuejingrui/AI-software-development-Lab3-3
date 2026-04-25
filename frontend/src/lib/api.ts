import { setGlobalError } from "../stores/error";
import type { ApiResponse } from "../types/api";

function getBaseUrl(): string {
  const env = import.meta.env.VITE_API_BASE_URL;
  return env && env.trim().length > 0 ? env : "http://127.0.0.1:8000";
}

async function apiRequest<T>(path: string, method: "GET" | "POST" | "PUT", payload?: unknown): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const parsedBody = (await res.json()) as ApiResponse<T>;
    if (!res.ok) {
      throw new Error(parsedBody?.message ?? `HTTP ${res.status}`);
    }
    if (parsedBody.code !== 0) {
      throw new Error(parsedBody.message || "API error");
    }
    return parsedBody.data as T;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Network error";
    setGlobalError(message);
    throw e;
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  return apiRequest<T>(path, "GET");
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>(path, "POST", body);
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>(path, "PUT", body);
}
