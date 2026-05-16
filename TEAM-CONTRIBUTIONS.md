# Team Contributions

This document matches `seed-team-history.ps1`. It keeps the same six-day history and folds the latest fixes into the original commits where they logically belong, instead of adding a fake extra repair day.

## Summary

| Person | Main ownership | Commits |
| --- | --- | --- |
| **Mohamed Aziz Mansour** | Frontend, Chat Service, Model Service | 18 |
| **Mohamed Ncib** (Hama) | API Gateway, REST/GraphQL boundary, Docker, Postman | 8 |
| **Rimel Zouari** | Activity Service, persisted data, README, schemas | 8 |

Shared base work on `main` contains the monorepo setup, gRPC proto contract, and GraphQL contract. Aziz merged the three feature branches back to `main` on Day 6 with merge commits.

## Day-By-Day Timeline

| Day | Date | Work |
| --- | --- | --- |
| 1 | May 9 | Shared monorepo, proto, GraphQL contracts |
| 2 | May 10 | Workspace scaffolding for frontend, gateway, and services |
| 3 | May 11 | Core gRPC services, REST gateway, activity database |
| 4 | May 12 | Kafka, frontend chat/log pages, Postman, first docs |
| 5 | May 13 | Reliability fixes, UI polish, activity ownership, final docs |
| 6 | May 14 | PR merges into `main` |

## Day 1 — Shared Base On `main`

### `initial setup` — Aziz

Files: `.gitignore`, `package.json`, `package-lock.json`, `tsconfig.base.json`

Creates the Node.js workspace monorepo with shared TypeScript config and scripts for development, backend build, frontend build, typecheck, Docker Kafka, and Docker Compose. The root stays clean: package code lives under `backend/gateway`, `backend/services/*`, and `frontend/web`.

### `add proto file for grpc` — Aziz

File: `backend/proto/platform.proto`

Defines the required `simplechat.v1` gRPC boundary:

- `ChatService.SendMessage`
- `ModelService.Generate` and `ModelService.ListModels`
- `ActivityService.ListConversations`, `GetMessages`, `UpdateConversation`, `DeleteConversation`, `ListLogs`, `RecordLog`, and `GetUsage`

This file is the internal contract between the API Gateway and the microservices.

### `add graphql schema` — Aziz

Files: `backend/contracts/graphql/schema.graphql`, `backend/graphql/schema.graphql`

Defines the public GraphQL read model exposed by the gateway. The schema includes `models`, `conversations`, `conversationMessages`, `logs`, and `usage`, with `pinned: Boolean!` matching the backend DTO.

## Aziz Branch — Frontend, Chat Service, Model Service

### `setup next js with tailwind`

Files: `frontend/web/package.json`, `frontend/web/tsconfig.json`, `frontend/web/next.config.ts`, `frontend/web/postcss.config.mjs`, `frontend/web/tailwind.config.ts`, `frontend/web/eslint.config.mjs`, `frontend/web/next-env.d.ts`, `frontend/web/public/.gitkeep`

Creates the Next.js 16 frontend package with typed routes, standalone output, Tailwind CSS, ESLint, and the public directory.

### `setup chat service`

Files: `backend/services/chat-service/package.json`, `backend/services/chat-service/tsconfig.json`, `backend/services/chat-service/src/node-sqlite.d.ts`

Creates the Chat Service workspace with gRPC, Kafka, Pino logging, TypeScript, and the `node:sqlite` type shim.

### `setup model service`

Files: `backend/services/model-service/package.json`, `backend/services/model-service/tsconfig.json`, `backend/services/model-service/src/node-sqlite.d.ts`

Creates the Model Service workspace with the same backend runtime stack.

### `write chat service grpc server with sqlite and kafka`

File: `backend/services/chat-service/src/index.ts`

Implements `ChatService.SendMessage` as the chat orchestrator:

- Validates workspace, request, conversation, model, messages, provider, and attachments.
- Stores request tracking in `chat.sqlite` through the `chat_requests` table.
- Publishes `chat.message.sent.v1` and `chat.reply.created.v1` business events.
- Calls `ModelService.Generate` over gRPC.
- Emits `system.log.created.v1` events for step 2, step 4, and failures.
- Uses a Kafka producer retry loop with an in-memory bounded queue so startup ordering does not silently drop events.

This preserves service ownership: Chat Service coordinates the workflow but does not own conversation history.

### `write model service that calls the provider`

File: `backend/services/model-service/src/index.ts`

Implements `ModelService.ListModels` and `ModelService.Generate`:

- Calls OpenAI-compatible `/models` and `/chat/completions` endpoints.
- Supports JSON responses, real SSE streams, and SSE text bodies.
- Stores request tracking in `model.sqlite` through `model_requests`.
- Emits `system.log.created.v1` step 3 events with model, provider, latency, prompt preview, attachment metadata, and reply preview.
- Uses the same queued Kafka producer pattern as Chat Service.

### `add layout and app shell`

Files: `frontend/web/src/app/layout.tsx`, `frontend/web/src/app/globals.css`, `frontend/web/src/components/layout/app-shell.tsx`

Builds the root application shell: sidebar, conversation list, model picker, settings dialog, theme bootstrap, workspace display, and layout structure. The sidebar refresh now retries after chat completion so Activity Service has time to consume Kafka and persist the new conversation.

### `add api client and workspace id hook`

Files: `frontend/web/src/services/api.ts`, `frontend/web/src/types/index.ts`, `frontend/web/src/hooks/use-workspace-id.ts`

Creates the browser-to-gateway API layer:

- Adds `x-luna-workspace-id` to gateway requests.
- Wraps REST calls with timeouts and cancellation.
- Sends full chat turns to the backend, not only the last prompt.
- Supports conversations, messages, logs, UI log recording, SSE log streaming, model listing, and provider model fetching.

### `add model and theme settings plus attachment reader`

Files: `frontend/web/src/services/model-settings.ts`, `frontend/web/src/services/theme-settings.ts`, `frontend/web/src/services/attachment-reader.ts`

Stores provider settings in browser localStorage, applies theme tokens through CSS variables, and reads text-compatible attachments for chat context.

### `build chat page and conversation sidebar`

Files: `frontend/web/src/app/page.tsx`, `frontend/web/src/app/chat/page.tsx`, `frontend/web/src/components/chat/chat-page.tsx`

Builds the chat UI. The current version fixes the important conversation bugs:

- New real conversations immediately move the browser to `/chat?conv=<id>`.
- Native `history.pushState` no longer triggers a premature history reload that overwrites the in-flight local messages.
- Regeneration sends the correct previous turns.
- Conversation loading is skipped when the active local conversation is already known.

### `build logs page with charts and live stream`

Files: `frontend/web/src/app/logs/page.tsx`, `frontend/web/src/components/logs/logs-page.tsx`

Builds the Activity page with status, service, and latency charts. Logs are grouped by `correlationId` into one chat-flow card. The flow expects these real backend actions: steps 1, 2, 3, 4, 5, 6, 7, and failure step 99. SSE snapshots are merged with already received live entries so real-time events are not lost by a late snapshot.

### `add markdown message and model icon`

Files: `frontend/web/src/components/markdown-message.tsx`, `frontend/web/src/components/model-icon.tsx`

Adds markdown rendering, code/artifact handling, copy/download helpers, and model-aware icons.

### UI polish commits

Files: `frontend/web/src/components/ui/**`, `frontend/web/src/app/error.tsx`, `frontend/web/src/app/global-error.tsx`, `frontend/web/src/utils/utils.ts`, `frontend/web/src/assets/**`

Adds reusable UI helpers, the animated chat matrix, thinking/scramble/shimmer components, visualization helpers, delete dialog, error boundaries, utilities, and assets.

## Hama Branch — API Gateway, Docker, Postman

### `setup gateway package`

Files: `backend/gateway/package.json`, `backend/gateway/tsconfig.json`

Creates the API Gateway workspace with Express, CORS, GraphQL, gRPC clients, Kafka, and Pino.

### `add docker files`

Files: `Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh`, `.dockerignore`

Adds Docker and Docker Compose for Kafka, the gateway, all three services, and the web client. Each stateful service gets its own Docker volume for SQLite.

### `start gateway with rest endpoints and grpc clients`

File: `backend/gateway/src/index.ts`

Creates the public entry point. The gateway loads `platform.proto`, creates gRPC clients for Chat, Model, and Activity, adds workspace/correlation middleware, maps gRPC errors to HTTP, and exposes the main REST endpoints.

### `add graphql endpoint and grpc response transforms`

File: `backend/gateway/src/index.ts`

Adds `/graphql` and DTO transforms between gRPC snake_case fields and frontend camelCase JSON. GraphQL resolvers call services over gRPC instead of reading databases directly.

### `add kafka producer and log consumer`

File: `backend/gateway/src/index.ts`

Adds reliable Kafka publishing and log streaming infrastructure:

- Creates the expected topics.
- Publishes `system.log.created.v1` with envelope `type` equal to the topic name.
- Retries Kafka connection with a bounded queue so logs are not dropped if Kafka starts late.
- Consumes `system.log.created.v1` for live SSE broadcasting.
- Does not store business data in the gateway.

### `add sse log stream endpoint`

File: `backend/gateway/src/index.ts`

Adds `GET /v1/logs/stream`. It sends an initial Activity Service snapshot, then streams Kafka log events in real time. Gateway-created chat logs are broadcast locally immediately and deduped when the same Kafka event comes back. Gateway logs are not written twice to Activity; Kafka is the storage path for log events, while gRPC remains the read/query path.

### Postman commits

Files: `postman/soa-clean.postman_collection.json`, `postman/soa-clean.postman_environment.json`

Adds REST, GraphQL, and gRPC testing instructions with workspace headers and local URLs.

## Rimel Branch — Activity Service, README, Schemas

### `setup activity service`

Files: `backend/services/activity-service/package.json`, `backend/services/activity-service/tsconfig.json`, `backend/services/activity-service/src/node-sqlite.d.ts`

Creates the Activity Service workspace.

### `start activity service with conversations and messages tables`

File: `backend/services/activity-service/src/index.ts`

Creates `activity.sqlite` ownership for conversations and messages, with WAL mode, foreign keys, indexes, pagination, row mapping, and gRPC handlers for conversation reads.

### `add logs table and filters to activity service`

File: `backend/services/activity-service/src/index.ts`

Adds the `logs` table, metadata JSON storage, filters by workspace/service/status/date/search, and `RecordLog`/`ListLogs` support.

### `add kafka consumers for chat messages and replies`

File: `backend/services/activity-service/src/index.ts`

Consumes real business events:

- `chat.message.sent.v1` stores the user message and emits step 5.
- `chat.reply.created.v1` stores the assistant message and emits step 6.
- `system.log.created.v1` stores service logs, ignoring Activity Service's own re-published log events to avoid duplicates.

Activity Service also has a queued Kafka producer so its own step 5/6 logs reach the gateway live stream.

### `fix log filter pagination and conversation upsert`

File: `backend/services/activity-service/src/index.ts`

Completes Activity Service behavior: transaction-safe message persistence, conversation upsert/update/delete, usage analytics, direct gRPC `RecordLog`, and live publication of directly recorded logs.

### `start writing readme` and `finish readme with diagrams and tables`

Files: `README.md`, `TEAM-CONTRIBUTIONS.md`, `seed-team-history.ps1`

Documents the project clearly for delivery: architecture, workflows, REST endpoints, Kafka topics, data ownership, Postman usage, Docker, and the complete logs step table. Mermaid labels are quoted where needed so diagrams render correctly.

### `add schemas doc`

File: `SCHEMAS.md`

Documents gRPC, GraphQL, Kafka envelopes, Kafka topics, chat-flow log actions, and SQLite schemas. The Kafka envelope `type` matches the topic name (`*.v1`).

## End-To-End Flow

When a user sends a chat message:

1. Frontend sends `POST /v1/chat/completions` to the gateway with workspace and provider/model settings.
2. Gateway emits step 1 and calls `ChatService.SendMessage` over gRPC.
3. Chat Service tracks the request, publishes `chat.message.sent.v1`, emits step 2, and calls Model Service over gRPC.
4. Model Service calls the OpenAI-compatible provider, tracks the request, and emits step 3.
5. Chat Service publishes `chat.reply.created.v1`, emits step 4, and returns the assistant reply.
6. Activity Service consumes the Kafka business events, stores messages/conversations, and emits steps 5 and 6.
7. Gateway emits step 7 and returns JSON to the frontend.
8. Logs page receives all `system.log.created.v1` events live through SSE and groups them by correlation ID.

This satisfies the assignment constraints: Node.js only, three microservices, API Gateway, REST, GraphQL, gRPC, Kafka, separate SQLite databases, and documented contracts.
