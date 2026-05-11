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
  void publish(topics.logs, "system.log.created", log, event.correlationId);
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

