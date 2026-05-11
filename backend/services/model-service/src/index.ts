import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { Kafka, logLevel, type Producer } from "kafkajs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";

const serviceName = "model-service";
const grpcPort = Number(process.env.MODEL_GRPC_PORT ?? 5103);
const healthPort = Number(process.env.MODEL_HEALTH_PORT ?? 4103);
const brokers = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",").map((value) => value.trim()).filter(Boolean);
const protoPath = fileURLToPath(new URL("../../../proto/platform.proto", import.meta.url));
const dbPath = process.env.MODEL_DB_PATH ?? fileURLToPath(new URL("../../../.data/model.sqlite", import.meta.url));
const logger = pino({ level: process.env.LOG_LEVEL ?? "info", base: { service: serviceName }, timestamp: pino.stdTimeFunctions.isoTime });

const topics = { logs: "system.log.created.v1" } as const;
const topicNames = ["chat.message.sent.v1", "chat.reply.created.v1", topics.logs];
interface ChatTurn {
  role: string;
  content: string;
}

interface GenerateRequest {
  workspace_id?: string;
  request_id?: string;
  conversation_id?: string;
  model?: string;
  messages?: ChatTurn[];
  attachments?: Array<{ name?: string; content?: string }>;
  provider?: ProviderConfig;
}

interface ProviderConfig {
  base_url?: string;
  api_key?: string;
  model?: string;
}

interface ModelListRequest {
  provider?: ProviderConfig;
}

interface LogPayload {
  id: string;
  timestamp: string;
  user: string;
  service: string;
  action: string;
  status: "success" | "warning" | "error";
  correlationId: string;
  metadata?: Record<string, unknown>;
}

let db: DatabaseSync;
let producer: Producer | undefined;

function loadGrpcPackage() {
  const definition = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
  });
  return (grpc.loadPackageDefinition(definition) as any).simplechat.v1;
}

async function initDb() {
  await mkdir(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS model_requests (
      request_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      streaming INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      latency_ms INTEGER,
      error_message TEXT
    );
  `);
  logger.info({ dbPath }, "model sqlite ready");
}

async function initKafka() {
  if (brokers.length === 0 || brokers.includes("disabled")) return;
  const kafka = new Kafka({ clientId: serviceName, brokers, logLevel: logLevel.ERROR });
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.createTopics({ waitForLeaders: true, topics: topicNames.map((topic) => ({ topic, numPartitions: 1, replicationFactor: 1 })) });
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
  producer = kafka.producer({ allowAutoTopicCreation: true });
  await producer.connect();
  logger.info({ brokers }, "kafka producer connected");
}

async function publish(topic: string, type: string, payload: unknown, correlationId: string) {
  if (!producer) return;
  const event = {
    id: randomUUID(),
    type,
    version: "1.0",
    source: serviceName,
    timestamp: new Date().toISOString(),
    correlationId,
    payload
  };
  await producer.send({ topic, messages: [{ key: correlationId, value: JSON.stringify(event) }] }).catch((error) => logger.warn({ error, topic }, "failed to publish kafka event"));
}

function workspaceId(request: GenerateRequest) {
  return request.workspace_id?.trim() || "local-workspace";
}

function workspaceLabel(request: GenerateRequest) {
  return `workspace:${workspaceId(request)}`;
}

function requestId(request: GenerateRequest) {
  return request.request_id?.trim() || randomUUID();
}

function selectedModel(request: GenerateRequest) {
  return request.provider?.model?.trim() || request.model?.trim() || "";
}

function providerBaseUrl(provider: ProviderConfig | undefined) {
  return provider?.base_url?.trim().replace(/\/+$/, "") || "";
}

function normalizeModels(value: unknown) {
  const raw = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data)
      ? (value as { data: unknown[] }).data
      : [];

  const models = raw
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      const model = item as { id?: unknown; name?: unknown };
      return typeof model.id === "string" ? model.id : typeof model.name === "string" ? model.name : "";
    })
    .map((item) => item.trim())
    .filter(Boolean);

  return models;
}

async function fetchProviderModels(provider: ProviderConfig | undefined) {
  const baseUrl = providerBaseUrl(provider);
  if (!baseUrl) return [];
  const headers: Record<string, string> = { accept: "application/json" };
  if (provider?.api_key?.trim()) headers.authorization = `Bearer ${provider.api_key.trim()}`;

  const response = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw grpcError(grpc.status.UNAVAILABLE, `Provider returned HTTP ${response.status}`);
  return normalizeModels(await response.json());
}

function lastUserMessage(request: GenerateRequest) {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  return [...messages].reverse().find((message) => message.role === "user")?.content?.trim() || "empty message";
}

function tokenCount(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function preview(value: string, maxLength = 600) {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}...` : clean;
}

function attachmentMetadata(request: GenerateRequest) {
  const attachments = Array.isArray(request.attachments) ? request.attachments.filter((file) => file.name || file.content) : [];
  return {
    attachmentCount: attachments.length,
    attachmentNames: attachments.map((file) => file.name || "attachment"),
    attachments: attachments.map((file) => ({
      name: file.name || "attachment",
      contentPreview: preview(file.content || "", 240)
    }))
  };
}

function recordStarted(request: GenerateRequest, streaming: boolean) {
  db.prepare("INSERT OR REPLACE INTO model_requests (request_id, workspace_id, conversation_id, model, status, streaming, created_at, completed_at, latency_ms, error_message) VALUES (?, ?, ?, ?, 'running', ?, ?, NULL, NULL, NULL)")
    .run(requestId(request), workspaceId(request), request.conversation_id || "", selectedModel(request), streaming ? 1 : 0, new Date().toISOString());
}

function recordFinished(request: GenerateRequest, status: "success" | "error", latencyMs: number, error?: string) {
  db.prepare("UPDATE model_requests SET status = ?, completed_at = ?, latency_ms = ?, error_message = ? WHERE request_id = ?")
    .run(status, new Date().toISOString(), Math.round(latencyMs), error ?? null, requestId(request));
}

async function publishLog(request: GenerateRequest, action: string, status: "success" | "error", startedAt: number, metadata: Record<string, unknown> = {}) {
  const correlationId = requestId(request);
  const log: LogPayload = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    user: workspaceLabel(request),
    service: serviceName,
    action,
    status,
    correlationId,
    metadata: { latencyMs: Math.round(performance.now() - startedAt), model: selectedModel(request), promptPreview: preview(lastUserMessage(request)), ...attachmentMetadata(request), ...metadata }
  };
  await publish(topics.logs, "system.log.created", log, correlationId);
}

function grpcError(code: grpc.status, message: string) {
  return Object.assign(new Error(message), { code });
}

function assertProviderReady(request: GenerateRequest) {
  const baseUrl = providerBaseUrl(request.provider);
  const model = selectedModel(request);
  if (!baseUrl) throw grpcError(grpc.status.INVALID_ARGUMENT, "A real OpenAI-compatible provider base_url is required. Configure a provider in Settings first.");
  if (!model) throw grpcError(grpc.status.INVALID_ARGUMENT, "A model id is required. Select a model in Settings first.");
  return { baseUrl, model, apiKey: request.provider?.api_key?.trim() || "" };
}

function providerHeaders(apiKey: string) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

function providerMessages(request: GenerateRequest) {
  const messages = Array.isArray(request.messages)
    ? request.messages
      .filter((message) => message.content?.trim())
      .map((message) => ({ role: message.role || "user", content: message.content }))
    : [];
  const attachments = Array.isArray(request.attachments) ? request.attachments.filter((file) => file.name || file.content) : [];

  if (attachments.length > 0) {
    messages.push({
      role: "user",
      content: [
        "Attached files for context:",
        ...attachments.map((file) => `\nFile: ${file.name || "attachment"}\n${file.content || "[no readable text]"}`)
      ].join("\n")
    });
  }

  if (messages.length === 0) throw grpcError(grpc.status.INVALID_ARGUMENT, "At least one chat message is required");
  return messages;
}

function textFromProviderResponse(value: unknown) {
  const response = value as { choices?: Array<{ message?: { content?: unknown }; text?: unknown }> };
  const choice = response.choices?.[0];
  const content = choice?.message?.content ?? choice?.text;
  if (typeof content === "string" && content.trim()) return content;
  throw grpcError(grpc.status.UNAVAILABLE, "Provider response did not contain assistant text");
}

function responseFromContent(request: GenerateRequest, content: string) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    conversation_id: request.conversation_id || randomUUID(),
    role: "assistant",
    content,
    model: selectedModel(request),
    prompt_tokens: tokenCount(lastUserMessage(request)),
    completion_tokens: tokenCount(content),
    created_at: now
  };
}

async function generateProviderResponse(request: GenerateRequest) {
  const provider = assertProviderReady(request);
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: providerHeaders(provider.apiKey),
    body: JSON.stringify({ model: provider.model, messages: providerMessages(request), stream: false }),
    signal: AbortSignal.timeout(120_000)
  });

  const contentType = response.headers.get("content-type") ?? "";
  if (response.ok && contentType.includes("text/event-stream")) {
    return responseFromContent(request, await collectProviderStream(response));
  }

  const text = await response.text();
  if (!response.ok) throw grpcError(grpc.status.UNAVAILABLE, `Provider returned HTTP ${response.status}: ${text.slice(0, 300)}`);

  if (text.trimStart().startsWith("data:")) {
    return responseFromContent(request, textFromProviderStreamText(text));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw grpcError(grpc.status.UNAVAILABLE, "Provider returned invalid JSON");
  }

  return responseFromContent(request, textFromProviderResponse(parsed));
}

function parseStreamContent(data: string) {
  if (data === "[DONE]") return { done: true, content: "" };
  try {
    const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown }; text?: unknown; finish_reason?: unknown }> };
    const choice = parsed.choices?.[0];
    const content = choice?.delta?.content ?? choice?.message?.content ?? choice?.text;
    return { done: Boolean(choice?.finish_reason), content: typeof content === "string" ? content : "" };
  } catch {
    return { done: false, content: "" };
  }
}

async function collectProviderStream(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw grpcError(grpc.status.UNAVAILABLE, "Provider did not return a response stream");

  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const data = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
      if (!data) continue;
      const parsed = parseStreamContent(data);
      if (parsed.content) fullContent += parsed.content;
      if (parsed.done) return fullContent;
    }
  }

  if (!fullContent.trim()) throw grpcError(grpc.status.UNAVAILABLE, "Provider stream ended without assistant text");
  return fullContent;
}

function textFromProviderStreamText(text: string) {
  let fullContent = "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data) continue;
    const parsed = parseStreamContent(data);
    if (parsed.content) fullContent += parsed.content;
    if (parsed.done) break;
  }
  if (!fullContent.trim()) throw grpcError(grpc.status.UNAVAILABLE, "Provider stream ended without assistant text");
  return fullContent;
}

async function main() {
  await initDb();
  await initKafka().catch((error) => logger.warn({ error }, "kafka unavailable"));

  const proto = loadGrpcPackage();
  const server = new grpc.Server();

  server.addService(proto.ModelService.service, {
    ListModels: async (call: grpc.ServerUnaryCall<ModelListRequest, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      try {
        callback(null, { models: await fetchProviderModels(call.request.provider) });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not list models";
        callback(error instanceof Error && "code" in error ? error as grpc.ServiceError : grpcError(grpc.status.UNAVAILABLE, message));
      }
    },

    Generate: async (call: grpc.ServerUnaryCall<GenerateRequest, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      const startedAt = performance.now();
      const request = call.request;
      try {
        recordStarted(request, false);
        const response = await generateProviderResponse(request);
        recordFinished(request, "success", performance.now() - startedAt);
        await publishLog(request, "model_generate_03_provider_completed", "success", startedAt, { step: 3, completionTokens: response.completion_tokens, replyPreview: preview(response.content, 1_200) });
        callback(null, response);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Model generation failed";
        recordFinished(request, "error", performance.now() - startedAt, message);
        await publishLog(request, "model_generate_03_provider_failed", "error", startedAt, { step: 3, error: message });
        callback(error instanceof Error && "code" in error ? error as grpc.ServiceError : grpcError(grpc.status.INTERNAL, message));
      }
    }
  });

  server.bindAsync(`0.0.0.0:${grpcPort}`, grpc.ServerCredentials.createInsecure(), (error, boundPort) => {
    if (error) throw error;
    server.start();
    logger.info({ port: boundPort }, "model gRPC server listening");
  });

  createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ service: serviceName, status: "ok", grpcPort, dbPath }));
  }).listen(healthPort, () => logger.info({ port: healthPort }, "model health endpoint listening"));
}

main().catch((error) => {
  logger.fatal({ error }, "model service failed to start");
  process.exit(1);
});
