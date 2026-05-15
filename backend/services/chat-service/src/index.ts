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

const serviceName = "chat-service";
const grpcPort = Number(process.env.CHAT_GRPC_PORT ?? 5102);
const healthPort = Number(process.env.CHAT_HEALTH_PORT ?? 4102);
const modelGrpcUrl = process.env.MODEL_GRPC_URL ?? "localhost:5103";
const brokers = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",").map((value) => value.trim()).filter(Boolean);
const protoPath = fileURLToPath(new URL("../../../proto/platform.proto", import.meta.url));
const dbPath = process.env.CHAT_DB_PATH ?? fileURLToPath(new URL("../../../.data/chat.sqlite", import.meta.url));
const logger = pino({ level: process.env.LOG_LEVEL ?? "info", base: { service: serviceName }, timestamp: pino.stdTimeFunctions.isoTime });

const topics = {
  userMessage: "chat.message.sent.v1",
  assistantMessage: "chat.reply.created.v1",
  logs: "system.log.created.v1"
} as const;
const topicNames = Object.values(topics);

interface ChatTurn {
  role: string;
  content: string;
}

interface ChatRequest {
  workspace_id?: string;
  request_id?: string;
  conversation_id?: string;
  model?: string;
  messages?: ChatTurn[];
  attachments?: Array<{ name?: string; type?: string; size?: number; content?: string; truncated?: boolean }>;
  provider?: { base_url?: string; api_key?: string; model?: string };
}

interface ChatMessagePayload {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  tokens: number;
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

interface PendingKafkaMessage {
  topic: string;
  key: string;
  value: string;
}

let db: DatabaseSync;
let producer: Producer | undefined;
let producerConnecting = false;
let modelClient: any;
const pendingKafkaMessages: PendingKafkaMessage[] = [];
const maxPendingKafkaMessages = 1_000;

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
    CREATE TABLE IF NOT EXISTS chat_requests (
      request_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      latency_ms INTEGER,
      error_message TEXT
    );
  `);
  logger.info({ dbPath }, "chat sqlite ready");
}

async function initKafka() {
  if (kafkaDisabled() || producer || producerConnecting) return;
  producerConnecting = true;
  void (async () => {
    for (let attempt = 1; !producer; attempt += 1) {
      const kafka = new Kafka({ clientId: serviceName, brokers, logLevel: logLevel.ERROR });
      let nextProducer: Producer | undefined;
      try {
        await ensureKafkaTopics(kafka);
        nextProducer = kafka.producer({ allowAutoTopicCreation: true });
        await nextProducer.connect();
        producer = nextProducer;
        logger.info({ brokers, pending: pendingKafkaMessages.length }, "kafka producer connected");
        await flushKafkaMessages();
        return;
      } catch (error) {
        await nextProducer?.disconnect().catch(() => undefined);
        logger.warn({ error, attempt }, "kafka producer unavailable; retrying");
        await sleep(Math.min(10_000, 1_000 + attempt * 1_000));
      }
    }
  })().finally(() => {
    producerConnecting = false;
    if (!producer && pendingKafkaMessages.length > 0) void initKafka();
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureKafkaTopics(kafka: Kafka) {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const existing = new Set(await admin.listTopics());
    const missing = topicNames.filter((topic) => !existing.has(topic));
    if (missing.length === 0) return;
    await admin.createTopics({ waitForLeaders: true, topics: missing.map((topic) => ({ topic, numPartitions: 1, replicationFactor: 1 })) });
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}

function kafkaDisabled() {
  return brokers.length === 0 || brokers.includes("disabled");
}

function queueKafkaMessage(message: PendingKafkaMessage) {
  if (pendingKafkaMessages.length >= maxPendingKafkaMessages) pendingKafkaMessages.shift();
  pendingKafkaMessages.push(message);
}

async function sendKafkaMessage(message: PendingKafkaMessage) {
  if (!producer) throw new Error("Kafka producer is not connected");
  await producer.send({ topic: message.topic, messages: [{ key: message.key, value: message.value }] });
}

async function flushKafkaMessages() {
  while (producer && pendingKafkaMessages.length > 0) {
    const message = pendingKafkaMessages.shift();
    if (!message) return;
    try {
      await sendKafkaMessage(message);
    } catch (error) {
      pendingKafkaMessages.unshift(message);
      const staleProducer = producer;
      producer = undefined;
      await staleProducer.disconnect().catch(() => undefined);
      logger.warn({ error, pending: pendingKafkaMessages.length }, "failed to flush kafka events; reconnecting");
      void initKafka();
      return;
    }
  }
}

async function publish(topic: string, type: string, payload: unknown, correlationId: string) {
  if (kafkaDisabled()) return;
  const event = {
    id: randomUUID(),
    type,
    version: "1.0",
    source: serviceName,
    timestamp: new Date().toISOString(),
    correlationId,
    payload
  };
  const message: PendingKafkaMessage = { topic, key: correlationId, value: JSON.stringify(event) };
  if (!producer) {
    queueKafkaMessage(message);
    void initKafka();
    return;
  }
  try {
    await sendKafkaMessage(message);
  } catch (error) {
    queueKafkaMessage(message);
    const staleProducer = producer;
    producer = undefined;
    await staleProducer.disconnect().catch(() => undefined);
    logger.warn({ error, topic }, "failed to publish kafka event");
    void initKafka();
  }
}

function normalizeRequest(raw: ChatRequest): Required<Pick<ChatRequest, "workspace_id" | "request_id" | "conversation_id" | "model" | "messages" | "attachments">> & Pick<ChatRequest, "provider"> {
  const messages = Array.isArray(raw.messages) ? raw.messages.filter((message) => message.content?.trim()) : [];
  if (messages.length === 0) throw grpcError(grpc.status.INVALID_ARGUMENT, "At least one message is required");
  const model = raw.provider?.model?.trim() || raw.model?.trim() || "";
  if (!model) throw grpcError(grpc.status.INVALID_ARGUMENT, "A selected model is required");
  return {
    workspace_id: raw.workspace_id?.trim() || "local-workspace",
    request_id: raw.request_id?.trim() || randomUUID(),
    conversation_id: raw.conversation_id?.trim() || randomUUID(),
    model,
    messages,
    attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
    provider: raw.provider
  };
}

function workspaceLabel(request: { workspace_id: string }) {
  return `workspace:${request.workspace_id}`;
}

function lastUserPrompt(messages: ChatTurn[]) {
  return [...messages].reverse().find((message) => message.role === "user")?.content?.trim() || messages[messages.length - 1]?.content?.trim() || "";
}

function tokenCount(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function titleFromPrompt(prompt: string) {
  return prompt.replace(/\s+/g, " ").trim().slice(0, 80) || "New conversation";
}

function preview(value: string, maxLength = 600) {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}...` : clean;
}

function attachmentMetadata(request: ReturnType<typeof normalizeRequest>) {
  const attachments = request.attachments.filter((file) => file.name || file.content);
  return {
    attachmentCount: attachments.length,
    attachmentNames: attachments.map((file) => file.name || "attachment"),
    attachments: attachments.map((file) => ({
      name: file.name || "attachment",
      type: file.type || "application/octet-stream",
      size: file.size ?? 0,
      truncated: Boolean(file.truncated),
      contentPreview: preview(file.content || "", 240)
    }))
  };
}

function grpcMessage(message: ChatMessagePayload) {
  return {
    id: message.id,
    conversation_id: message.conversationId,
    role: message.role,
    content: message.content,
    created_at: message.createdAt,
    tokens: message.tokens
  };
}

function grpcError(code: grpc.status, message: string) {
  return Object.assign(new Error(message), { code });
}

function recordStarted(request: ReturnType<typeof normalizeRequest>, prompt: string) {
  db.prepare("INSERT OR REPLACE INTO chat_requests (request_id, workspace_id, conversation_id, model, prompt, status, created_at, completed_at, latency_ms, error_message) VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, NULL, NULL)")
    .run(request.request_id, request.workspace_id, request.conversation_id, request.model, prompt, new Date().toISOString());
}

function recordFinished(request: ReturnType<typeof normalizeRequest>, status: "success" | "error", latencyMs: number, error?: string) {
  db.prepare("UPDATE chat_requests SET status = ?, completed_at = ?, latency_ms = ?, error_message = ? WHERE request_id = ?")
    .run(status, new Date().toISOString(), Math.round(latencyMs), error ?? null, request.request_id);
}

async function publishLog(request: ReturnType<typeof normalizeRequest>, action: string, status: "success" | "error", startedAt: number, metadata: Record<string, unknown> = {}) {
  const log: LogPayload = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    user: workspaceLabel(request),
    service: serviceName,
    action,
    status,
    correlationId: request.request_id,
    metadata: { latencyMs: Math.round(performance.now() - startedAt), model: request.model, provider: request.provider?.base_url ?? "", conversationId: request.conversation_id, ...metadata }
  };
  await publish(topics.logs, topics.logs, log, request.request_id);
}

async function publishUserMessage(request: ReturnType<typeof normalizeRequest>, message: ChatMessagePayload) {
  await publish(topics.userMessage, topics.userMessage, {
    workspaceId: request.workspace_id,
    conversationId: request.conversation_id,
    model: request.model,
    title: titleFromPrompt(message.content),
    message
  }, request.request_id);
}

async function publishAssistantMessage(request: ReturnType<typeof normalizeRequest>, message: ChatMessagePayload) {
  await publish(topics.assistantMessage, topics.assistantMessage, {
    workspaceId: request.workspace_id,
    conversationId: request.conversation_id,
    model: request.model,
    title: titleFromPrompt(lastUserPrompt(request.messages)),
    message
  }, request.request_id);
}

function modelGenerate(request: ReturnType<typeof normalizeRequest>): Promise<any> {
  return new Promise((resolve, reject) => {
    modelClient.Generate({
      workspace_id: request.workspace_id,
      request_id: request.request_id,
      conversation_id: request.conversation_id,
      model: request.model,
      messages: request.messages,
      attachments: request.attachments,
      provider: request.provider
    }, (error: grpc.ServiceError | null, response: any) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

async function prepareConversation(request: ReturnType<typeof normalizeRequest>) {
  const prompt = lastUserPrompt(request.messages);
  const message: ChatMessagePayload = {
    id: randomUUID(),
    conversationId: request.conversation_id,
    role: "user",
    content: prompt,
    createdAt: new Date().toISOString(),
    tokens: tokenCount(prompt)
  };
  recordStarted(request, prompt);
  await publishUserMessage(request, message);
  return { prompt, message };
}

function assistantMessageFromModel(request: ReturnType<typeof normalizeRequest>, response: any, fallbackContent?: string): ChatMessagePayload {
  const content = String(response?.content ?? fallbackContent ?? "");
  return {
    id: String(response?.id ?? randomUUID()),
    conversationId: request.conversation_id,
    role: "assistant",
    content,
    createdAt: String(response?.created_at ?? new Date().toISOString()),
    tokens: Number(response?.completion_tokens ?? tokenCount(content))
  };
}

async function main() {
  await initDb();
  await initKafka().catch((error) => logger.warn({ error }, "kafka unavailable"));

  const proto = loadGrpcPackage();
  modelClient = new proto.ModelService(modelGrpcUrl, grpc.credentials.createInsecure());
  const server = new grpc.Server();

  server.addService(proto.ChatService.service, {
    SendMessage: async (call: grpc.ServerUnaryCall<ChatRequest, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      const startedAt = performance.now();
      let request: ReturnType<typeof normalizeRequest> | undefined;
      try {
        request = normalizeRequest(call.request);
        const { prompt } = await prepareConversation(request);
        await publishLog(request, "chat_message_02_user_saved", "success", startedAt, { step: 2, promptTokens: tokenCount(prompt), promptPreview: preview(prompt), ...attachmentMetadata(request) });
        const modelResponse = await modelGenerate(request);
        const assistant = assistantMessageFromModel(request, modelResponse);
        await publishAssistantMessage(request, assistant);
        await publishLog(request, "chat_reply_04_assistant_saved", "success", startedAt, { step: 4, promptPreview: preview(prompt), replyPreview: preview(assistant.content, 1_200), completionTokens: assistant.tokens, ...attachmentMetadata(request) });
        recordFinished(request, "success", performance.now() - startedAt);
        callback(null, { message: grpcMessage(assistant), conversation_id: request.conversation_id, model: request.model, prompt_tokens: tokenCount(lastUserPrompt(request.messages)), completion_tokens: assistant.tokens });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Chat request failed";
        if (request) {
          recordFinished(request, "error", performance.now() - startedAt, message);
          await publishLog(request, "chat_error_99_failed", "error", startedAt, { step: 99, error: message, promptPreview: preview(lastUserPrompt(request.messages)), ...attachmentMetadata(request) });
        }
        callback(error instanceof Error && "code" in error ? error as grpc.ServiceError : grpcError(grpc.status.INTERNAL, message));
      }
    }
  });

  server.bindAsync(`0.0.0.0:${grpcPort}`, grpc.ServerCredentials.createInsecure(), (error, boundPort) => {
    if (error) throw error;
    server.start();
    logger.info({ port: boundPort, modelGrpcUrl }, "chat gRPC server listening");
  });

  createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ service: serviceName, status: "ok", grpcPort, modelGrpcUrl, dbPath }));
  }).listen(healthPort, () => logger.info({ port: healthPort }, "chat health endpoint listening"));
}

main().catch((error) => {
  logger.fatal({ error }, "chat service failed to start");
  process.exit(1);
});
