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
