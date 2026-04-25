import { setGlobalError } from "../stores/error";
import type { ApiResponse } from "../types/api";

function getBaseUrl(): string {
  const env = import.meta.env.VITE_API_BASE_URL;
  return env && env.trim().length > 0 ? env : "http://127.0.0.1:8000";
}

export async function apiGet<T>(path: string): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  try {
    const res = await fetch(url, { method: "GET" });
    const body = (await res.json()) as ApiResponse<T>;
    if (!res.ok) {
      throw new Error(body?.message ?? `HTTP ${res.status}`);
    }
    if (body.code !== 0) {
      throw new Error(body.message || "API error");
    }
    return body.data as T;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Network error";
    setGlobalError(message);
    throw e;
  }
}

