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

const serviceName = "activity-service";
const grpcPort = Number(process.env.ACTIVITY_GRPC_PORT ?? 5104);
const healthPort = Number(process.env.ACTIVITY_HEALTH_PORT ?? 4104);
const brokers = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",").map((value) => value.trim()).filter(Boolean);
const protoPath = fileURLToPath(new URL("../../../proto/platform.proto", import.meta.url));
const dbPath = process.env.ACTIVITY_DB_PATH ?? fileURLToPath(new URL("../../../.data/activity.sqlite", import.meta.url));
const logger = pino({ level: process.env.LOG_LEVEL ?? "info", base: { service: serviceName }, timestamp: pino.stdTimeFunctions.isoTime });

const topics = {
  userMessage: "chat.message.sent.v1",
  assistantMessage: "chat.reply.created.v1",
  logs: "system.log.created.v1"
} as const;
const topicNames = Object.values(topics);

type LogStatus = "success" | "warning" | "error";

interface EventEnvelope<T> {
  id: string;
  type: string;
  version: "1.0";
  source: string;
  timestamp: string;
  correlationId: string;
  payload: T;
}

interface ChatMessagePayload {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  tokens: number;
}

interface ChatEventPayload {
  workspaceId: string;
  conversationId: string;
  model: string;
  title: string;
  message: ChatMessagePayload;
}

interface LogPayload {
  id: string;
  timestamp: string;
  user: string;
  service: string;
  action: string;
  status: LogStatus;
  correlationId: string;
  metadata?: Record<string, unknown>;
}

interface PendingKafkaMessage {
  topic: string;
  key: string;
  value: string;
}

interface ConversationRow {
  id: string;
  workspace_id: string;
  title: string;
  model: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  pinned: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: string;
  tokens: number | null;
}

interface LogRow {
  id: string;
  timestamp: string;
  user: string;
  service: string;
  action: string;
  status: string;
  correlation_id: string;
  metadata_json: string;
}

let db: DatabaseSync;
let producer: Producer | undefined;
let producerConnecting = false;
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
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      title TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      tokens INTEGER,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS logs (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      user TEXT NOT NULL,
      service TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_workspace_updated ON conversations(workspace_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_logs_user_timestamp ON logs(user, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_service_timestamp ON logs(service, timestamp DESC);
  `);
  logger.info({ dbPath }, "activity sqlite ready");
}

function workspaceId(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : "local-workspace";
}

function workspaceLabel(id: string) {
  return `workspace:${id}`;
}

function pageParams(pageInput: unknown, pageSizeInput: unknown) {
  const page = Math.max(1, Number(pageInput) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(pageSizeInput) || 20));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function validStatus(value: unknown): LogStatus {
  return value === "warning" || value === "error" ? value : "success";
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function conversationFromRow(row: ConversationRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
    pinned: Boolean(row.pinned)
  };
}

function messageFromRow(row: MessageRow) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    tokens: row.tokens ?? 0
  };
}

function logFromRow(row: LogRow): LogPayload {
  return {
    id: row.id,
    timestamp: row.timestamp,
    user: row.user,
    service: row.service,
    action: row.action,
    status: validStatus(row.status),
    correlationId: row.correlation_id,
    metadata: parseJson(row.metadata_json)
  };
}

function grpcConversation(conversation: ReturnType<typeof conversationFromRow>) {
  return {
    id: conversation.id,
    workspace_id: conversation.workspaceId,
    title: conversation.title,
    model: conversation.model,
    created_at: conversation.createdAt,
    updated_at: conversation.updatedAt,
    message_count: conversation.messageCount,
    pinned: conversation.pinned
  };
}

function grpcMessage(message: ReturnType<typeof messageFromRow> | ChatMessagePayload) {
  return {
    id: message.id,
    conversation_id: message.conversationId,
    role: message.role,
    content: message.content,
    created_at: message.createdAt,
    tokens: message.tokens ?? 0
  };
}

function grpcLog(log: LogPayload) {
  return {
    id: log.id,
    timestamp: log.timestamp,
    user: log.user,
    service: log.service,
    action: log.action,
    status: log.status,
    correlation_id: log.correlationId,
    metadata_json: JSON.stringify(log.metadata ?? {})
  };
}

function logFromGrpc(input: any): LogPayload {
  return {
    id: String(input?.id || randomUUID()),
    timestamp: String(input?.timestamp || new Date().toISOString()),
    user: String(input?.user || "unknown"),
    service: String(input?.service || "unknown-service"),
    action: String(input?.action || "unknown.action"),
    status: validStatus(input?.status),
    correlationId: String(input?.correlation_id || randomUUID()),
    metadata: typeof input?.metadata_json === "string" ? parseJson(input.metadata_json) : {}
  };
}

function addLog(log: LogPayload) {
  db.prepare("INSERT OR REPLACE INTO logs (id, timestamp, user, service, action, status, correlation_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(log.id, log.timestamp, log.user, log.service, log.action, validStatus(log.status), log.correlationId, JSON.stringify(log.metadata ?? {}));
}

function addActivityLog(event: EventEnvelope<unknown>, workspaceIdValue: string, action: string, metadata: Record<string, unknown>) {
  const log: LogPayload = {
    id: `${event.id}:activity`,
    timestamp: new Date().toISOString(),
    user: workspaceLabel(workspaceIdValue),
    service: serviceName,
    action,
    status: "success",
    correlationId: event.correlationId,
    metadata
  };
  addLog(log);
  void publish(topics.logs, topics.logs, log, event.correlationId);
}

function upsertConversation(payload: ChatEventPayload) {
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT * FROM conversations WHERE id = ?").get(payload.conversationId) as ConversationRow | undefined;
  if (!existing) {
    db.prepare("INSERT INTO conversations (id, workspace_id, title, model, created_at, updated_at, message_count, pinned) VALUES (?, ?, ?, ?, ?, ?, 0, 0)")
      .run(payload.conversationId, payload.workspaceId, payload.title || "New conversation", payload.model || "unknown-model", now, now);
    return;
  }
  db.prepare("UPDATE conversations SET title = COALESCE(NULLIF(?, ''), title), model = ?, updated_at = ? WHERE id = ?")
    .run(payload.title || existing.title, payload.model || existing.model, now, payload.conversationId);
}

function saveMessageEvent(payload: ChatEventPayload) {
  db.exec("BEGIN");
  try {
    upsertConversation(payload);
    db.prepare("INSERT OR IGNORE INTO messages (id, conversation_id, role, content, created_at, tokens) VALUES (?, ?, ?, ?, ?, ?)")
      .run(payload.message.id, payload.conversationId, payload.message.role, payload.message.content, payload.message.createdAt, payload.message.tokens ?? null);
    const count = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?").get(payload.conversationId) as { count?: number } | undefined;
    db.prepare("UPDATE conversations SET message_count = ?, updated_at = ? WHERE id = ?")
      .run(count?.count ?? 0, new Date().toISOString(), payload.conversationId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function listConversations(input: { workspaceId: string; page?: unknown; pageSize?: unknown; search?: unknown }) {
  const { page, pageSize, offset } = pageParams(input.page, input.pageSize);
  const search = typeof input.search === "string" && input.search.trim() ? `%${input.search.trim().toLowerCase()}%` : undefined;
  const where = search ? "WHERE workspace_id = ? AND (LOWER(title) LIKE ? OR LOWER(model) LIKE ?)" : "WHERE workspace_id = ?";
  const params = search ? [input.workspaceId, search, search] : [input.workspaceId];
  const total = (db.prepare(`SELECT COUNT(*) AS total FROM conversations ${where}`).get(...params) as { total?: number } | undefined)?.total ?? 0;
  const rows = db.prepare(`SELECT * FROM conversations ${where} ORDER BY pinned DESC, updated_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as ConversationRow[];
  return { data: rows.map(conversationFromRow), page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

function findConversation(id: string, workspaceIdValue: string) {
  const row = db.prepare("SELECT * FROM conversations WHERE id = ? AND workspace_id = ?").get(id, workspaceIdValue) as ConversationRow | undefined;
  if (!row) throw grpcError(grpc.status.NOT_FOUND, "Conversation not found");
  return conversationFromRow(row);
}

function getMessages(conversationId: string) {
  const rows = db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC").all(conversationId) as MessageRow[];
  return rows.map(messageFromRow);
}

function updateConversation(input: { id: string; workspaceId: string; title?: string; pinned?: boolean }) {
  const current = findConversation(input.id, input.workspaceId);
  const title = input.title?.trim() ? input.title.trim().slice(0, 120) : current.title;
  const pinned = typeof input.pinned === "boolean" ? input.pinned : current.pinned;
  db.prepare("UPDATE conversations SET title = ?, pinned = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
    .run(title, pinned ? 1 : 0, new Date().toISOString(), input.id, input.workspaceId);
  return findConversation(input.id, input.workspaceId);
}

function deleteConversation(id: string, workspaceIdValue: string) {
  findConversation(id, workspaceIdValue);
  db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
  db.prepare("DELETE FROM conversations WHERE id = ? AND workspace_id = ?").run(id, workspaceIdValue);
  return { deleted: true, id };
}

function filterLogs(query: { workspaceId: string; service?: unknown; status?: unknown; date?: unknown; search?: unknown }) {
  const clauses = ["user = ?"];
  const params: unknown[] = [workspaceLabel(query.workspaceId)];
  if (typeof query.service === "string" && query.service.trim()) {
    clauses.push("service = ?");
    params.push(query.service.trim());
  }
  if (typeof query.status === "string" && query.status.trim()) {
    clauses.push("status = ?");
    params.push(query.status.trim());
  }
  if (typeof query.date === "string" && query.date.trim()) {
    clauses.push("timestamp LIKE ?");
    params.push(`${query.date.trim()}%`);
  }
  if (typeof query.search === "string" && query.search.trim()) {
    const search = `%${query.search.trim().toLowerCase()}%`;
    clauses.push("(LOWER(service) LIKE ? OR LOWER(action) LIKE ? OR LOWER(status) LIKE ? OR LOWER(correlation_id) LIKE ? OR LOWER(metadata_json) LIKE ?)");
    params.push(search, search, search, search, search);
  }
  const rows = db.prepare(`SELECT * FROM logs WHERE ${clauses.join(" AND ")} ORDER BY timestamp DESC LIMIT 5000`).all(...params) as LogRow[];
  return rows.map(logFromRow);
}

function listLogs(input: { workspaceId: string; page?: unknown; pageSize?: unknown; service?: unknown; status?: unknown; date?: unknown; search?: unknown }) {
  const { page, pageSize } = pageParams(input.page, input.pageSize);
  const all = filterLogs(input);
  const start = (page - 1) * pageSize;
  return { data: all.slice(start, start + pageSize), page, pageSize, total: all.length, totalPages: Math.max(1, Math.ceil(all.length / pageSize)) };
}

function usage(workspaceIdValue: string) {
  const conversations = (db.prepare("SELECT COUNT(*) AS total FROM conversations WHERE workspace_id = ?").get(workspaceIdValue) as { total?: number } | undefined)?.total ?? 0;
  const messages = (db.prepare("SELECT COUNT(*) AS total FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE workspace_id = ?)").get(workspaceIdValue) as { total?: number } | undefined)?.total ?? 0;
  const logs = filterLogs({ workspaceId: workspaceIdValue });
  const errors = logs.filter((log) => log.status === "error").length;
  const latencies = logs.map((log) => log.metadata?.latencyMs).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    active_users: conversations > 0 || logs.length > 0 ? 1 : 0,
    conversations,
    messages,
    error_rate: Number((errors / Math.max(logs.length, 1)).toFixed(3)),
    average_latency_ms: Math.round(latencies.reduce((sum, value) => sum + value, 0) / Math.max(latencies.length, 1))
  };
}

function grpcError(code: grpc.status, message: string) {
  return Object.assign(new Error(message), { code });
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
    await admin.createTopics({
      waitForLeaders: true,
      topics: missing.map((topic) => ({ topic, numPartitions: 1, replicationFactor: 1 }))
    });
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}

function makeEnvelope<T>(type: string, payload: T, correlationId: string): EventEnvelope<T> {
  return {
    id: randomUUID(),
    type,
    version: "1.0",
    source: serviceName,
    timestamp: new Date().toISOString(),
    correlationId,
    payload
  };
}

async function publish(topic: string, type: string, payload: unknown, correlationId: string) {
  if (kafkaDisabled()) return;
  const message: PendingKafkaMessage = { topic, key: correlationId, value: JSON.stringify(makeEnvelope(type, payload, correlationId)) };
  if (!producer) {
    queueKafkaMessage(message);
    void startKafkaProducer();
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
    void startKafkaProducer();
  }
}

async function startKafkaProducer() {
  if (kafkaDisabled() || producer || producerConnecting) return;
  producerConnecting = true;
  void (async () => {
    for (let attempt = 1; !producer; attempt += 1) {
      const kafka = new Kafka({ clientId: `${serviceName}-producer`, brokers, logLevel: logLevel.ERROR });
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
    if (!producer && pendingKafkaMessages.length > 0) void startKafkaProducer();
  });
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
      void startKafkaProducer();
      return;
    }
  }
}

async function startConsumer<T>(topic: string, groupId: string, handler: (event: EventEnvelope<T>) => void) {
  if (kafkaDisabled()) return;

  void (async () => {
    for (let attempt = 1; ; attempt += 1) {
      const kafka = new Kafka({ clientId: `${serviceName}-${groupId}`, brokers, logLevel: logLevel.ERROR });
      const consumer = kafka.consumer({ groupId, allowAutoTopicCreation: true });
      try {
        await ensureKafkaTopics(kafka);
        await consumer.connect();
        await consumer.subscribe({ topic, fromBeginning: true });
        await consumer.run({
          eachMessage: async ({ message }) => {
            if (!message.value) return;
            const event = JSON.parse(message.value.toString()) as EventEnvelope<T>;
            handler(event);
          }
        });
        logger.info({ topic, groupId }, "kafka consumer connected");
        return;
      } catch (error) {
        await consumer.disconnect().catch(() => undefined);
        logger.warn({ error, topic, groupId, attempt }, "kafka consumer unavailable; retrying");
        await sleep(Math.min(10_000, 1_000 + attempt * 1_000));
      }
    }
  })();
}

async function startKafkaConsumers() {
  await startConsumer<ChatEventPayload>(topics.userMessage, "activity-user-messages", (event) => {
    saveMessageEvent(event.payload);
    addActivityLog(event, event.payload.workspaceId, "activity_user_message_05_kafka_consumed", { step: 5, conversationId: event.payload.conversationId, model: event.payload.model, source: event.source, promptPreview: event.payload.message.content.replace(/\s+/g, " ").trim().slice(0, 600) });
  });
  await startConsumer<ChatEventPayload>(topics.assistantMessage, "activity-assistant-messages", (event) => {
    saveMessageEvent(event.payload);
    addActivityLog(event, event.payload.workspaceId, "activity_reply_06_kafka_consumed", { step: 6, conversationId: event.payload.conversationId, model: event.payload.model, source: event.source, replyPreview: event.payload.message.content.replace(/\s+/g, " ").trim().slice(0, 1_200) });
  });
  await startConsumer<LogPayload>(topics.logs, "activity-logs", (event) => {
    if (event.source === serviceName) return;
    addLog(event.payload);
  });
}

async function main() {
  await initDb();
  await startKafkaProducer().catch((error) => logger.warn({ error }, "kafka producer unavailable"));
  await startKafkaConsumers().catch((error) => logger.warn({ error }, "kafka consumers unavailable"));

  const proto = loadGrpcPackage();
  const server = new grpc.Server();

  server.addService(proto.ActivityService.service, {
    ListConversations: (call: grpc.ServerUnaryCall<any, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      try {
        const result = listConversations({ workspaceId: workspaceId(call.request.workspace_id), page: call.request.page, pageSize: call.request.page_size, search: call.request.search });
        callback(null, { data: result.data.map(grpcConversation), page: result.page, page_size: result.pageSize, total: result.total, total_pages: result.totalPages });
      } catch (error) {
        callback(error as grpc.ServiceError);
      }
    },

    GetMessages: (call: grpc.ServerUnaryCall<any, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      try {
        const conversation = findConversation(call.request.id, workspaceId(call.request.workspace_id));
        callback(null, { data: getMessages(conversation.id).map(grpcMessage) });
      } catch (error) {
        callback(error as grpc.ServiceError);
      }
    },

    UpdateConversation: (call: grpc.ServerUnaryCall<any, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      try {
        const conversation = updateConversation({ id: call.request.id, workspaceId: workspaceId(call.request.workspace_id), title: call.request.title, pinned: call.request.has_pinned ? Boolean(call.request.pinned) : undefined });
        callback(null, { conversation: grpcConversation(conversation) });
      } catch (error) {
        callback(error as grpc.ServiceError);
      }
    },

    DeleteConversation: (call: grpc.ServerUnaryCall<any, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      try {
        callback(null, deleteConversation(call.request.id, workspaceId(call.request.workspace_id)));
      } catch (error) {
        callback(error as grpc.ServiceError);
      }
    },

    ListLogs: (call: grpc.ServerUnaryCall<any, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      try {
        const result = listLogs({ workspaceId: workspaceId(call.request.workspace_id), page: call.request.page, pageSize: call.request.page_size, service: call.request.service, status: call.request.status, date: call.request.date, search: call.request.search });
        callback(null, { data: result.data.map(grpcLog), page: result.page, page_size: result.pageSize, total: result.total, total_pages: result.totalPages });
      } catch (error) {
        callback(error as grpc.ServiceError);
      }
    },

    RecordLog: async (call: grpc.ServerUnaryCall<any, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      try {
        const log = logFromGrpc(call.request);
        addLog(log);
        await publish(topics.logs, topics.logs, log, log.correlationId);
        callback(null, { log: grpcLog(log) });
      } catch (error) {
        callback(error as grpc.ServiceError);
      }
    },

    GetUsage: (call: grpc.ServerUnaryCall<any, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      try {
        callback(null, usage(workspaceId(call.request.workspace_id)));
      } catch (error) {
        callback(error as grpc.ServiceError);
      }
    }
  });

  server.bindAsync(`0.0.0.0:${grpcPort}`, grpc.ServerCredentials.createInsecure(), (error, boundPort) => {
    if (error) throw error;
    server.start();
    logger.info({ port: boundPort }, "activity gRPC server listening");
  });

  createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ service: serviceName, status: "ok", grpcPort, dbPath }));
  }).listen(healthPort, () => logger.info({ port: healthPort }, "activity health endpoint listening"));
}

main().catch((error) => {
  logger.fatal({ error }, "activity service failed to start");
  process.exit(1);
});
