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

async function startLogStreamConsumer() {
  if (brokers.length === 0 || brokers.includes("disabled")) return;

  void (async () => {
    for (let attempt = 1; ; attempt += 1) {
      const kafka = new Kafka({ clientId: `${serviceName}-log-stream`, brokers, logLevel: logLevel.ERROR });
      const consumer = kafka.consumer({ groupId: `${serviceName}-log-stream`, allowAutoTopicCreation: true });
      try {
        await ensureKafkaTopics(kafka);
        await consumer.connect();
        await consumer.subscribe({ topic: topics.logs, fromBeginning: false });
        await consumer.run({
          eachMessage: async ({ message }) => {
            if (!message.value || logClients.size === 0) return;
            const event = JSON.parse(message.value.toString()) as EventEnvelope<LogPayload>;
            broadcastLog(event.payload);
          }
        });
        logger.info({ topic: topics.logs }, "kafka log stream consumer connected");
        return;
      } catch (error) {
        await consumer.disconnect().catch(() => undefined);
        logger.warn({ error, attempt }, "kafka log stream unavailable; retrying");
        await sleep(Math.min(10_000, 1_000 + attempt * 1_000));
      }
    }
  })();
}

const app = express();
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(requestContext);
app.use((req, res, next) => {
  const startedAt = performance.now();
  res.on("finish", () => {
    if (req.path === "/health" || req.path === "/v1/logs/stream") return;
    if (req.path === "/v1/logs") return;
    if (req.method === "POST" && req.path === "/v1/chat/completions") return;
    if (req.method === "GET" && (req.path === "/v1/logs" || req.path.startsWith("/v1/conversations"))) return;
    void recordAndBroadcastLog(makeLog(req, req.path === "/graphql" ? "graphql.request" : `${req.method} ${req.path}`, statusFromCode(res.statusCode), { latencyMs: Math.round(performance.now() - startedAt), method: req.method, path: req.path, statusCode: res.statusCode }));
  });
  next();
});

app.get("/health", (_req, res) => {
  res.json({ service: serviceName, status: "ok", grpc: { chat: process.env.CHAT_GRPC_URL ?? "localhost:5102", model: process.env.MODEL_GRPC_URL ?? "localhost:5103", activity: process.env.ACTIVITY_GRPC_URL ?? "localhost:5104" } });
});

app.get("/graphql/schema", (_req, res) => res.type("text/plain").send(graphqlSchemaText));

app.post("/graphql", route(async (req, res) => {
  const query = typeof req.body?.query === "string" ? req.body.query : "";
  if (!query.trim()) {
    res.status(400).json({ errors: [{ message: "GraphQL query is required" }] });
    return;
  }
  const result = await graphql({
    schema: graphqlSchema,
    source: query,
    rootValue: graphqlRoot(req),
    variableValues: req.body?.variables,
    operationName: typeof req.body?.operationName === "string" ? req.body.operationName : undefined
  });
  res.status(result.errors?.length && !result.data ? 400 : 200).json(result);
}));

app.post("/v1/provider/models", route(async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const result = await unary<any>(grpcClients.model, "ListModels", {
    provider: {
      base_url: body.base_url ?? body.baseUrl ?? "",
      api_key: body.api_key ?? body.apiKey ?? "",
      model: body.model ?? ""
    }
  });
  res.json({ models: Array.isArray(result.models) ? result.models : [] });
}));

app.get("/v1/models", route(async (req, res) => {
  const result = await unary<any>(grpcClients.model, "ListModels", {
    provider: {
      base_url: req.query.baseUrl ?? req.query.base_url ?? "",
      api_key: req.query.apiKey ?? req.query.api_key ?? "",
      model: req.query.model ?? ""
    }
  });
  res.json({ models: Array.isArray(result.models) ? result.models : [] });
}));

app.post("/v1/chat/completions", route(async (req, res) => {
  await recordAndBroadcastLog(makeLog(req, "chat_request_01_gateway_received", "success", chatGatewayMetadata(req, 1)));
  const result = await unary<any>(grpcClients.chat, "SendMessage", chatRequest(req));
  await recordAndBroadcastLog(makeLog(req, "chat_response_07_gateway_returned", "success", chatGatewayMetadata(req, 7, {
    conversationId: String(result.conversation_id ?? result.message?.conversation_id ?? ""),
    completionTokens: Number(result.completion_tokens ?? 0),
    replyPreview: String(result.message?.content ?? "").replace(/\s+/g, " ").trim().slice(0, 1_200)
  })));
  res.json({
    message: messageFromGrpc(result.message),
    conversationId: String(result.conversation_id ?? result.message?.conversation_id ?? ""),
    model: String(result.model ?? "unknown-model"),
    usage: { promptTokens: Number(result.prompt_tokens ?? 0), completionTokens: Number(result.completion_tokens ?? 0) }
  });
}));

app.get("/v1/conversations", route(async (req, res) => {
  res.json(conversationPageFromGrpc(await unary(grpcClients.activity, "ListConversations", {
    workspace_id: workspaceId(req),
    page: req.query.page,
    page_size: req.query.pageSize,
    search: req.query.search
  })));
}));

app.get("/v1/conversations/:id/messages", route(async (req, res) => {
  res.json(messageListFromGrpc(await unary(grpcClients.activity, "GetMessages", { workspace_id: workspaceId(req), id: req.params.id })));
}));

app.patch("/v1/conversations/:id", route(async (req, res) => {
  const result = await unary<any>(grpcClients.activity, "UpdateConversation", {
    workspace_id: workspaceId(req),
    id: req.params.id,
    title: req.body?.title,
    pinned: Boolean(req.body?.pinned),
    has_pinned: typeof req.body?.pinned === "boolean"
  });
  const conversation = conversationFromGrpc(result.conversation);
  if (typeof req.body?.title === "string" && req.body.title.trim()) {
    await recordAndBroadcastLog(makeLog(req, "conversation.renamed", "success", { conversationId: req.params.id, title: conversation.title, model: conversation.model }));
  }
  if (typeof req.body?.pinned === "boolean") {
    await recordAndBroadcastLog(makeLog(req, req.body.pinned ? "conversation.pinned" : "conversation.unpinned", "success", { conversationId: req.params.id, title: conversation.title, model: conversation.model, pinned: conversation.pinned }));
  }
  res.json({ conversation });
}));

app.delete("/v1/conversations/:id", route(async (req, res) => {
  const result = await unary(grpcClients.activity, "DeleteConversation", { workspace_id: workspaceId(req), id: req.params.id });
  await recordAndBroadcastLog(makeLog(req, "conversation.deleted", "success", { conversationId: req.params.id }));
  res.json(result);
}));

app.get("/v1/logs", route(async (req, res) => {
  res.json(await listLogs(req));
}));

app.get("/v1/logs/stream", route(async (req, res) => {
  const snapshot = await listLogs(req);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.write(`data: ${JSON.stringify({ type: "snapshot", ...snapshot })}\n\n`);

  const client: LogClient = { res, workspace: workspaceLabel(req), query: req.query };
  logClients.add(client);
  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(": keep-alive\n\n");
  }, 20_000);
  const cleanup = () => {
    clearInterval(keepAlive);
    logClients.delete(client);
  };
  req.on("aborted", cleanup);
  res.on("close", cleanup);
}));

app.post("/v1/logs", route(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const logPayload: LogPayload = {
    id: String(body.id || randomUUID()),
    timestamp: String(body.timestamp || new Date().toISOString()),
    user: String(body.user || workspaceLabel(req)),
    service: String(body.service || serviceName),
    action: String(body.action || "manual.log"),
    status: body.status === "warning" || body.status === "error" ? body.status : "success",
    correlationId: String(body.correlationId || correlationId(req)),
    metadata: body.metadata && typeof body.metadata === "object" ? body.metadata as Record<string, unknown> : {}
  };
  await recordAndBroadcastLog(logPayload);
  res.status(201).json({ log: logPayload });
}));

app.get("/v1/analytics/usage", route(async (req, res) => {
  res.json(usageFromGrpc(await unary(grpcClients.activity, "GetUsage", { workspace_id: workspaceId(req) })));
}));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = grpcHttpStatus(error);
  logger.warn({ error, status }, "gateway request failed");
  res.status(status).json({ error: { code: "GATEWAY_ERROR", message: grpcMessage(error) } });
});

await startKafkaProducer().catch((error) => logger.warn({ error }, "kafka producer unavailable"));
await startLogStreamConsumer().catch((error) => logger.warn({ error }, "kafka log stream unavailable"));

app.listen(port, () => logger.info({ port }, "api gateway listening"));
