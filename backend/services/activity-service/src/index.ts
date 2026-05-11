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
