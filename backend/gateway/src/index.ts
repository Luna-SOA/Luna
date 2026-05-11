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
