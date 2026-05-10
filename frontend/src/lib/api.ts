import { setGlobalError } from "../stores/error";
import type { ApiResponse } from "../types/api";

function getBaseUrl(): string {
  const env = import.meta.env.VITE_API_BASE_URL;
  return env && env.trim().length > 0 ? env : "/api";
}

type ApiRequestOptions = {
  silent?: boolean;
  timeoutMs?: number;
};

async function apiRequest<T>(
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  payload?: unknown,
  options: ApiRequestOptions = {}
): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 30000;
  const timeoutHandle = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: controller.signal,
    });
    const rawBody = await res.text();
    let parsedBody: ApiResponse<T> | null = null;
    if (rawBody.trim().length > 0) {
      try {
        parsedBody = JSON.parse(rawBody) as ApiResponse<T>;
      } catch {
        parsedBody = null;
      }
    }
    if (!res.ok) {
      const fallbackMessage = rawBody.trim() || `HTTP ${res.status}`;
      throw new Error(parsedBody?.message ?? fallbackMessage);
    }
    if (!parsedBody) {
      throw new Error("服务响应格式错误");
    }
    if (parsedBody.code !== 0) {
      throw new Error(parsedBody.message || "API error");
    }
    return parsedBody.data as T;
  } catch (e) {
    const message =
      e instanceof DOMException && e.name === "AbortError"
        ? "请求超时，请稍后重试"
        : e instanceof Error
          ? e.message
          : "Network error";
    if (!options.silent) {
      setGlobalError(message);
    }
    throw new Error(message);
  } finally {
    window.clearTimeout(timeoutHandle);
  }
}

export async function apiGet<T>(path: string, options?: ApiRequestOptions): Promise<T> {
  return apiRequest<T>(path, "GET", undefined, options);
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>(path, "POST", body);
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>(path, "PUT", body);
}

export async function apiDelete<T>(path: string): Promise<T> {
  return apiRequest<T>(path, "DELETE");
}
