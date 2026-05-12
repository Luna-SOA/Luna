import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { buildSchema, graphql } from "graphql";
import { Kafka, logLevel, type Producer } from "kafkajs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pino from "pino";

const serviceName = "api-gateway";
const port = Number(process.env.API_GATEWAY_PORT ?? process.env.PORT ?? 8080);
const corsOrigin = process.env.CORS_ORIGIN ?? "http://localhost:3000";
const brokers = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",").map((value) => value.trim()).filter(Boolean);
const protoPath = fileURLToPath(new URL("../../proto/platform.proto", import.meta.url));
const logger = pino({ level: process.env.LOG_LEVEL ?? "info", base: { service: serviceName }, timestamp: pino.stdTimeFunctions.isoTime });

const topics = {
  logs: "system.log.created.v1"
} as const;
const topicNames = ["chat.message.sent.v1", "chat.reply.created.v1", topics.logs];

type LogStatus = "success" | "warning" | "error";

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

interface EventEnvelope<T> {
  id: string;
  type: string;
  version: "1.0";
  source: string;
  timestamp: string;
  correlationId: string;
  payload: T;
}

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

const proto = loadGrpcPackage();
const grpcClients = {
  chat: new proto.ChatService(process.env.CHAT_GRPC_URL ?? "localhost:5102", grpc.credentials.createInsecure()),
  model: new proto.ModelService(process.env.MODEL_GRPC_URL ?? "localhost:5103", grpc.credentials.createInsecure()),
  activity: new proto.ActivityService(process.env.ACTIVITY_GRPC_URL ?? "localhost:5104", grpc.credentials.createInsecure())
};

function unary<T>(client: any, method: string, request: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    client[method](request, (error: grpc.ServiceError | null, response: T) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

function workspaceId(req: Request) {
  const value = req.headers["x-luna-workspace-id"];
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 120);
  const queryValue = req.query.workspaceId ?? req.query.workspace_id;
  return typeof queryValue === "string" && queryValue.trim() ? queryValue.trim().slice(0, 120) : "local-workspace";
}

function workspaceLabel(req: Request) {
  return `workspace:${workspaceId(req)}`;
}

function correlationId(req: Request) {
  return String(req.headers["x-correlation-id"] ?? randomUUID());
}

function requestContext(req: Request, _res: Response, next: NextFunction) {
  req.headers["x-correlation-id"] = correlationId(req);
  next();
}

function statusFromCode(code: number): LogStatus {
  if (code >= 500) return "error";
  if (code >= 400) return "warning";
  return "success";
}

function grpcHttpStatus(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error ? Number((error as { code?: unknown }).code) : grpc.status.UNKNOWN;
  if (code === grpc.status.INVALID_ARGUMENT) return 400;
  if (code === grpc.status.NOT_FOUND) return 404;
  if (code === grpc.status.ALREADY_EXISTS) return 409;
  if (code === grpc.status.UNAVAILABLE) return 502;
  if (code === grpc.status.DEADLINE_EXCEEDED) return 504;
  return 500;
}

function grpcMessage(error: unknown) {
  return error instanceof Error ? error.message.replace(/^\d+\s+[A-Z_]+:\s*/, "") : "gRPC service failed";
}

function makeEnvelope<T>(type: string, payload: T, correlation: string): EventEnvelope<T> {
  return {
    id: randomUUID(),
    type,
    version: "1.0",
    source: serviceName,
    timestamp: new Date().toISOString(),
    correlationId: correlation,
    payload
  };
}

let producer: Producer | undefined;

async function startKafkaProducer() {
  if (brokers.length === 0 || brokers.includes("disabled")) return;
  const kafka = new Kafka({ clientId: serviceName, brokers, logLevel: logLevel.ERROR });
  await ensureKafkaTopics(kafka);
  producer = kafka.producer({ allowAutoTopicCreation: true });
  await producer.connect();
  logger.info({ brokers }, "kafka producer connected");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureKafkaTopics(kafka: Kafka) {
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.createTopics({ waitForLeaders: true, topics: topicNames.map((topic) => ({ topic, numPartitions: 1, replicationFactor: 1 })) });
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}

async function publish(topic: string, type: string, payload: unknown, correlation: string) {
  if (!producer) return;
  try {
    await producer.send({ topic, messages: [{ key: correlation, value: JSON.stringify(makeEnvelope(type, payload, correlation)) }] });
  } catch (error) {
    logger.warn({ error, topic }, "failed to publish kafka event");
  }
}

function jsonMetadata(value: unknown) {
  return JSON.stringify(value ?? {});
}

function parseMetadata(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function messageFromGrpc(input: any) {
  return {
    id: String(input?.id ?? ""),
    conversationId: String(input?.conversation_id ?? ""),
    role: String(input?.role ?? "assistant"),
    content: String(input?.content ?? ""),
    createdAt: String(input?.created_at ?? new Date().toISOString()),
    tokens: Number(input?.tokens ?? 0)
  };
}

function conversationFromGrpc(input: any) {
  return {
    id: String(input?.id ?? ""),
    workspaceId: String(input?.workspace_id ?? ""),
    title: String(input?.title ?? "Untitled conversation"),
    model: String(input?.model ?? "unknown-model"),
    createdAt: String(input?.created_at ?? new Date().toISOString()),
    updatedAt: String(input?.updated_at ?? new Date().toISOString()),
    messageCount: Number(input?.message_count ?? 0),
    pinned: Boolean(input?.pinned)
  };
}

function logFromGrpc(input: any) {
  return {
    id: String(input?.id ?? ""),
    timestamp: String(input?.timestamp ?? new Date().toISOString()),
    user: String(input?.user ?? "unknown"),
    service: String(input?.service ?? "unknown-service"),
    action: String(input?.action ?? "unknown.action"),
    status: String(input?.status ?? "success") as LogStatus,
    correlationId: String(input?.correlation_id ?? ""),
    metadata: parseMetadata(input?.metadata_json)
  };
}

function conversationPageFromGrpc(input: any) {
  return {
    data: Array.isArray(input?.data) ? input.data.map(conversationFromGrpc) : [],
    page: Number(input?.page ?? 1),
    pageSize: Number(input?.page_size ?? 20),
    total: Number(input?.total ?? 0),
    totalPages: Number(input?.total_pages ?? 1)
  };
}

function messageListFromGrpc(input: any) {
  return { data: Array.isArray(input?.data) ? input.data.map(messageFromGrpc) : [] };
}

function logPageFromGrpc(input: any) {
  return {
    data: Array.isArray(input?.data) ? input.data.map(logFromGrpc) : [],
    page: Number(input?.page ?? 1),
    pageSize: Number(input?.page_size ?? 20),
    total: Number(input?.total ?? 0),
    totalPages: Number(input?.total_pages ?? 1)
  };
}

function usageFromGrpc(input: any) {
  return {
    activeUsers: Number(input?.active_users ?? 0),
    conversations: Number(input?.conversations ?? 0),
    messages: Number(input?.messages ?? 0),
    errorRate: Number(input?.error_rate ?? 0),
    averageLatencyMs: Number(input?.average_latency_ms ?? 0)
  };
}

function chatRequest(req: Request) {
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, any> : {};
  const provider = body.provider && typeof body.provider === "object" ? body.provider : undefined;
  return {
    workspace_id: workspaceId(req),
    request_id: correlationId(req),
    conversation_id: typeof body.conversationId === "string" ? body.conversationId : "",
    model: typeof body.model === "string" ? body.model : typeof provider?.model === "string" ? provider.model : "",
    messages: Array.isArray(body.messages) ? body.messages : [],
    provider,
    attachments: Array.isArray(body.attachments) ? body.attachments : []
  };
}

function lastRequestMessage(req: Request) {
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, any> : {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const content = [...messages].reverse().find((message) => message?.role === "user")?.content ?? messages[messages.length - 1]?.content ?? "";
  return typeof content === "string" ? content.replace(/\s+/g, " ").trim().slice(0, 600) : "";
}

function chatGatewayMetadata(req: Request, step: number, extra: Record<string, unknown> = {}) {
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, any> : {};
  const provider = body.provider && typeof body.provider === "object" ? body.provider : undefined;
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  return {
    step,
    requestId: correlationId(req),
    conversationId: typeof body.conversationId === "string" ? body.conversationId : "",
    model: typeof body.model === "string" ? body.model : typeof provider?.model === "string" ? provider.model : "",
    promptPreview: lastRequestMessage(req),
    attachmentCount: attachments.length,
    attachmentNames: attachments.map((file) => typeof file?.name === "string" ? file.name : "attachment"),
    ...extra
  };
}

async function listLogs(req: Request) {
  return logPageFromGrpc(await unary(grpcClients.activity, "ListLogs", {
    workspace_id: workspaceId(req),
    page: req.query.page,
    page_size: req.query.pageSize,
    service: req.query.service,
    status: req.query.status,
    date: req.query.date,
    search: req.query.search
  }));
}

function route(handler: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res)).catch(next);
  };
}

const graphqlSchemaText = `
type Conversation { id: ID!, workspaceId: ID!, title: String!, model: String!, createdAt: String!, updatedAt: String!, messageCount: Int!, pinned: Boolean! }
type ChatMessage { id: ID!, conversationId: ID!, role: String!, content: String!, createdAt: String!, tokens: Int }
type LogEntry { id: ID!, timestamp: String!, user: String!, service: String!, action: String!, status: String!, correlationId: String! }
type ConversationPage { data: [Conversation!]!, page: Int!, pageSize: Int!, total: Int!, totalPages: Int! }
type MessageList { data: [ChatMessage!]! }
type LogPage { data: [LogEntry!]!, page: Int!, pageSize: Int!, total: Int!, totalPages: Int! }
type Usage { activeUsers: Int!, conversations: Int!, messages: Int!, errorRate: Float!, averageLatencyMs: Int! }
type Query {
  models: [String!]!
  conversations(page: Int, pageSize: Int, search: String): ConversationPage!
  conversationMessages(id: ID!): MessageList!
  logs(page: Int, pageSize: Int, service: String, status: String, date: String, search: String): LogPage!
  usage: Usage!
}`;

const graphqlSchema = buildSchema(graphqlSchemaText);

function graphqlRoot(req: Request) {
  return {
    models: async () => {
      const result = await unary<any>(grpcClients.model, "ListModels", {});
      return Array.isArray(result.models) ? result.models : [];
    },
    conversations: async (args: { page?: number; pageSize?: number; search?: string }) => conversationPageFromGrpc(await unary(grpcClients.activity, "ListConversations", {
      workspace_id: workspaceId(req),
      page: args.page,
      page_size: args.pageSize,
      search: args.search
    })),
    conversationMessages: async (args: { id: string }) => messageListFromGrpc(await unary(grpcClients.activity, "GetMessages", { workspace_id: workspaceId(req), id: args.id })),
    logs: async (args: { page?: number; pageSize?: number; service?: string; status?: string; date?: string; search?: string }) => logPageFromGrpc(await unary(grpcClients.activity, "ListLogs", {
      workspace_id: workspaceId(req),
      page: args.page,
      page_size: args.pageSize,
      service: args.service,
      status: args.status,
      date: args.date,
      search: args.search
    })),
    usage: async () => usageFromGrpc(await unary(grpcClients.activity, "GetUsage", { workspace_id: workspaceId(req) }))
  };
}

type LogClient = { res: Response; workspace: string; query: Request["query"] };
const logClients = new Set<LogClient>();

function logMatchesQuery(entry: LogPayload, query: Request["query"]) {
  if (typeof query.service === "string" && query.service.trim() && entry.service !== query.service.trim()) return false;
  if (typeof query.status === "string" && query.status.trim() && entry.status !== query.status.trim()) return false;
  if (typeof query.date === "string" && query.date.trim() && !entry.timestamp.startsWith(query.date.trim())) return false;
  if (typeof query.search === "string" && query.search.trim()) {
    const search = query.search.trim().toLowerCase();
    const value = `${entry.service} ${entry.action} ${entry.status} ${entry.correlationId} ${JSON.stringify(entry.metadata ?? {})}`.toLowerCase();
    if (!value.includes(search)) return false;
  }
  return true;
}

function broadcastLog(entry: LogPayload) {
  if (logClients.size === 0) return;
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of logClients) {
    if (client.workspace === entry.user && logMatchesQuery(entry, client.query) && !client.res.writableEnded) client.res.write(data);
  }
}

function grpcLogPayload(log: LogPayload) {
  return {
    id: log.id,
    timestamp: log.timestamp,
    user: log.user,
    service: log.service,
    action: log.action,
    status: log.status,
    correlation_id: log.correlationId,
    metadata_json: jsonMetadata(log.metadata)
  };
}

function makeLog(req: Request, action: string, status: LogStatus, metadata: Record<string, unknown> = {}): LogPayload {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    user: workspaceLabel(req),
    service: serviceName,
    action,
    status,
    correlationId: correlationId(req),
    metadata
  };
}

async function recordAndBroadcastLog(log: LogPayload) {
  try {
    await unary(grpcClients.activity, "RecordLog", grpcLogPayload(log));
  } catch (error) {
    logger.warn({ error, action: log.action }, "failed to record activity log with gRPC");
  }
  broadcastLog(log);
  await publish(topics.logs, "system.log.created", log, log.correlationId);
}

