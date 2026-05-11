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

// ── Streaming SSE helpers ──────────────────────────────────────────────

export interface StreamCallbacks<T> {
  onToken: (text: string) => void;
  onDone: (result: T) => void;
  onError: (message: string) => void;
}

function parseSseChunk<T>(
  rawChunk: string,
  callbacks: StreamCallbacks<T>
): boolean {
  const normalized = rawChunk.replace(/\r\n/g, "\n").trim();
  if (!normalized) return false;

  let currentEvent = "";
  let doneReceived = false;
  const lines = normalized.split("\n");
  for (const line of lines) {
    if (line.startsWith("event:")) {
      currentEvent = line.slice(6).trim();
      continue;
    }
    if (!line.startsWith("data:")) continue;
    const dataStr = line.slice(5).trim();
    try {
      const parsed = JSON.parse(dataStr);
      if (currentEvent === "token") {
        callbacks.onToken(parsed.text || "");
      } else if (currentEvent === "done") {
        callbacks.onDone(parsed as T);
        doneReceived = true;
      } else if (currentEvent === "error") {
        callbacks.onError(parsed.message || "AI 服务错误");
      }
    } catch {
      // ignore malformed SSE payloads
    }
    currentEvent = "";
  }
  return doneReceived;
}

export async function apiPostStream<T>(
  path: string,
  body: unknown,
  callbacks: StreamCallbacks<T>
): Promise<void> {
  const url = `${getBaseUrl()}${path}`;
  const controller = new AbortController();
  const timeoutHandle = window.setTimeout(() => controller.abort(), 90000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorText = await res.text();
      callbacks.onError(`HTTP ${res.status}: ${errorText}`);
      return;
    }

    const reader = res.body?.getReader();
    if (!reader) {
      callbacks.onError("浏览器不支持流式读取");
      return;
    }

    const decoder = new TextDecoder();
    let sseBuffer = "";
    let doneReceived = false;
    let streamError: string | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (sseBuffer.trim()) {
          doneReceived = parseSseChunk<T>(sseBuffer, {
            onToken: callbacks.onToken,
            onDone: callbacks.onDone,
            onError(message: string) {
              streamError = message;
              callbacks.onError(message);
            },
          }) || doneReceived;
        }
        break;
      }

      sseBuffer += decoder.decode(value, { stream: true });
      sseBuffer = sseBuffer.replace(/\r\n/g, "\n");

      // SSE events are separated by double newlines
      const parts = sseBuffer.split("\n\n");
      sseBuffer = parts.pop() || "";

      for (const part of parts) {
        doneReceived = parseSseChunk<T>(part, {
          onToken: callbacks.onToken,
          onDone: callbacks.onDone,
          onError(message: string) {
            streamError = message;
            callbacks.onError(message);
          },
        }) || doneReceived;
      }

      if (doneReceived) {
        await reader.cancel();
        break;
      }
    }

    if (streamError) {
      throw new Error(streamError);
    }
    if (!doneReceived) {
      const message = "流式输出未正常结束，已中断本次生成";
      callbacks.onError(message);
      throw new Error(message);
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      callbacks.onError("请求超时，请稍后重试");
      throw new Error("请求超时，请稍后重试");
    } else {
      const message = e instanceof Error ? e.message : "网络错误";
      callbacks.onError(message);
      throw new Error(message);
    }
  } finally {
    window.clearTimeout(timeoutHandle);
  }
}
