import { getStoredWorkspaceId } from "@/hooks/use-workspace-id";
import type { ChatMessage, Conversation, LogEntry, Paginated } from "@/types";

const configuredBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "") ?? "";
const defaultDevBaseUrl = "http://localhost:8080";
const sameOriginProxyBaseUrl = "/api";
const requestTimeoutMs = 15_000;
const chatRequestTimeoutMs = 120_000;
const logStreamConnectTimeoutMs = 30_000;

export interface ChatAttachmentPayload {
  name: string;
  type: string;
  size: number;
  content: string;
  truncated?: boolean;
}

export interface ChatTurnPayload {
  role: "system" | "user" | "assistant";
  content: string;
}

export function getApiBaseUrl() {
  if (configuredBaseUrl) return configuredBaseUrl;
  if (typeof window !== "undefined" && process.env.NODE_ENV === "production" && window.location.port !== "3000") return sameOriginProxyBaseUrl;
  return defaultDevBaseUrl;
}

function withWorkspaceHeader(headers: HeadersInit | undefined) {
  const next = new Headers(headers);
  if (typeof window !== "undefined") next.set("x-luna-workspace-id", getStoredWorkspaceId());
  return next;
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
}

export async function apiFetch(pathOrUrl: string, options: RequestInit = {}, timeoutMs = requestTimeoutMs) {
  const isAbsoluteUrl = /^https?:\/\//i.test(pathOrUrl);
  const url = isAbsoluteUrl ? pathOrUrl : `${getApiBaseUrl()}${pathOrUrl}`;
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let abortListener: (() => void) | undefined;

  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else {
      abortListener = () => controller.abort();
      options.signal.addEventListener("abort", abortListener, { once: true });
    }
  }

  try {
    return await fetch(url, {
      ...options,
      headers: isAbsoluteUrl ? options.headers : withWorkspaceHeader(options.headers),
      signal: controller.signal
    });
  } catch (error) {
    if (isAbortError(error)) {
      if (!timedOut) throw new Error("Request cancelled");
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (abortListener) options.signal?.removeEventListener("abort", abortListener);
  }
}

async function requestJson<T>(path: string, options: RequestInit = {}, timeoutMs = requestTimeoutMs): Promise<T> {
  const response = await apiFetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {})
    },
    cache: "no-store"
  }, timeoutMs);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = text.slice(0, 200);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      message = parsed.error?.message ?? message;
    } catch {}
    throw new Error(`Request failed: ${response.status} ${message}`);
  }
  return response.json() as Promise<T>;
}

export async function sendChatMessage(input: { content: string; conversationId?: string; model?: string; provider?: { base_url: string; api_key: string; model: string }; messages?: ChatTurnPayload[]; attachments?: ChatAttachmentPayload[]; signal?: AbortSignal }) {
  return requestJson<{ message: ChatMessage; conversationId: string }>("/v1/chat/completions", {
    method: "POST",
    signal: input.signal,
    body: JSON.stringify({
      conversationId: input.conversationId,
      ...(input.model ? { model: input.model } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      messages: input.messages?.length ? input.messages : [{ role: "user", content: input.content }]
    })
  }, chatRequestTimeoutMs);
}

export async function getConversations(params: { page: number; pageSize: number; search?: string; signal?: AbortSignal }): Promise<Paginated<Conversation>> {
  const search = params.search ? `&search=${encodeURIComponent(params.search)}` : "";
  return requestJson<Paginated<Conversation>>(`/v1/conversations?page=${params.page}&pageSize=${params.pageSize}${search}`, {
    signal: params.signal
  });
}

export async function getConversationMessages(params: { conversationId: string; signal?: AbortSignal }): Promise<{ data: ChatMessage[] }> {
  return requestJson<{ data: ChatMessage[] }>(`/v1/conversations/${params.conversationId}/messages`, {
    signal: params.signal
  });
}

export async function deleteConversation(params: { conversationId: string; signal?: AbortSignal }): Promise<void> {
  await apiFetch(`/v1/conversations/${params.conversationId}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    signal: params.signal,
  }).then((res) => { if (!res.ok) throw new Error(`Delete failed: ${res.status}`); });
}

export async function updateConversation(params: { conversationId: string; title?: string; pinned?: boolean; signal?: AbortSignal }): Promise<Conversation> {
  const response = await requestJson<{ conversation: Conversation }>(`/v1/conversations/${params.conversationId}`, {
    method: "PATCH",
    body: JSON.stringify({ title: params.title, pinned: params.pinned }),
    signal: params.signal
  });
  return response.conversation;
}

export async function getLogs(params: { user?: string; service?: string; status?: LogEntry["status"] | ""; date?: string; search?: string; page: number; pageSize: number; signal?: AbortSignal }): Promise<Paginated<LogEntry>> {
  const query = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize) });
  if (params.user) query.set("user", params.user);
  if (params.service) query.set("service", params.service);
  if (params.status) query.set("status", params.status);
  if (params.date) query.set("date", params.date);
  if (params.search) query.set("search", params.search);

  return requestJson<Paginated<LogEntry>>(`/v1/logs?${query.toString()}`, {
    signal: params.signal
  });
}

export async function recordLog(input: { service?: string; action: string; status?: LogEntry["status"]; correlationId?: string; metadata?: Record<string, unknown> }) {
  return requestJson<{ log: LogEntry }>("/v1/logs", {
    method: "POST",
    body: JSON.stringify({
      service: input.service ?? "web-client",
      action: input.action,
      status: input.status ?? "success",
      correlationId: input.correlationId,
      metadata: input.metadata ?? {}
    })
  }, requestTimeoutMs);
}

function handleLogStreamPayload(parsed: unknown, params: {
  onSnapshot: (value: Paginated<LogEntry>) => void;
  onNewEntry: (entry: LogEntry) => void;
  onError: (message: string) => void;
}) {
  if (!parsed || typeof parsed !== "object") return;
  if ("error" in parsed && typeof parsed.error === "string") {
    params.onError(parsed.error);
    return;
  }
  if ("data" in parsed && Array.isArray((parsed as Paginated<LogEntry>).data)) {
    params.onSnapshot(parsed as Paginated<LogEntry>);
  } else if ("id" in parsed && "action" in parsed) {
    params.onNewEntry(parsed as LogEntry);
  }
}

export async function streamLogs(params: {
  user?: string;
  service?: string;
  status?: LogEntry["status"] | "";
  date?: string;
  search?: string;
  page: number;
  pageSize: number;
  onSnapshot: (value: Paginated<LogEntry>) => void;
  onNewEntry: (entry: LogEntry) => void;
  onError: (message: string) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const query = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize) });
  if (params.user) query.set("user", params.user);
  if (params.service) query.set("service", params.service);
  if (params.status) query.set("status", params.status);
  if (params.date) query.set("date", params.date);
  if (params.search) query.set("search", params.search);

  if (typeof window !== "undefined" && "EventSource" in window) {
    query.set("workspaceId", getStoredWorkspaceId());
    const url = new URL(`${getApiBaseUrl()}/v1/logs/stream`, window.location.origin);
    url.search = query.toString();

    await new Promise<void>((resolve) => {
      const source = new EventSource(url.toString());
      const close = () => {
        source.close();
        params.signal?.removeEventListener("abort", close);
        resolve();
      };

      source.onmessage = (event) => {
        try {
          handleLogStreamPayload(JSON.parse(event.data), params);
        } catch {
          // ignore malformed frames
        }
      };
      source.onerror = () => params.onError("Live stream disconnected; reconnecting automatically");

      if (params.signal?.aborted) close();
      else params.signal?.addEventListener("abort", close, { once: true });
    });
    return;
  }

  const response = await apiFetch(`/v1/logs/stream?${query.toString()}`, {
    cache: "no-store",
    signal: params.signal
  }, logStreamConnectTimeoutMs);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Log stream failed (${response.status})`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("Logs stream body missing");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await reader.read();
    } catch (error) {
      if (params.signal?.aborted || isAbortError(error)) return;
      throw error;
    }
    const { value, done } = result;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const json = line.slice(5).trim();
        if (!json) continue;
        try {
          handleLogStreamPayload(JSON.parse(json), params);
        } catch {
          // ignore malformed frames
        }
      }
    }
  }
  // Stream ended cleanly
}

export async function fetchModels(endpointBaseUrl: string, apiKey?: string): Promise<string[]> {
  const response = await requestJson<{ models: string[] }>("/v1/provider/models", {
    method: "POST",
    body: JSON.stringify({ baseUrl: endpointBaseUrl, apiKey })
  });
  return response.models;
}
