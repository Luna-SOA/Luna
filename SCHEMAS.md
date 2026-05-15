# Schemas And Contracts

This file documents the technical contracts used by the project: gRPC, GraphQL, Kafka events, and SQLite tables.

## gRPC Proto File

Main file: `backend/proto/platform.proto`

Package: `simplechat.v1`

### Services

| Service | Methods | Responsibility |
| --- | --- | --- |
| `ChatService` | `SendMessage` | Receives chat requests and calls Model Service |
| `ModelService` | `Generate`, `ListModels` | Calls the configured OpenAI-compatible provider for assistant answers |
| `ActivityService` | `ListConversations`, `GetMessages`, `UpdateConversation`, `DeleteConversation`, `ListLogs`, `RecordLog`, `GetUsage` | Stores conversations, logs, and metrics |

### Important Messages

| Message | Used For |
| --- | --- |
| `ChatRequest` | Request sent from Gateway to Chat Service |
| `ChatResponse` | Normal chat response |
| `GenerateRequest` | Request sent from Chat Service to Model Service |
| `GenerateResponse` | Model generated response |
| `Conversation` | Stored conversation summary |
| `ChatMessage` | Stored user or assistant message |
| `LogEntry` | Log item shown in the logs page |

## GraphQL Schema

Main file: `backend/graphql/schema.graphql`

```graphql
type Query {
  models: [String!]!
  conversations(page: Int, pageSize: Int, search: String): ConversationPage!
  conversationMessages(id: ID!): MessageList!
  logs(page: Int, pageSize: Int, service: String, status: String, date: String, search: String): LogPage!
  usage: Usage!
}
```

GraphQL is used for flexible read operations. The client can request only the fields it needs.

## Kafka Events

All Kafka messages are JSON envelopes. The envelope `type` matches the Kafka topic name.

```json
{
  "id": "event uuid",
  "type": "chat.message.sent.v1",
  "version": "1.0",
  "source": "service name",
  "timestamp": "ISO date",
  "correlationId": "request id",
  "payload": {}
}
```

### Topic: `chat.message.sent.v1`

Producer: `chat-service`

Consumer: `activity-service`

Scenario: a user sends a message.

Payload:

```json
{
  "workspaceId": "local-workspace",
  "conversationId": "uuid",
  "model": "gpt-5",
  "title": "short conversation title",
  "message": {
    "id": "uuid",
    "conversationId": "uuid",
    "role": "user",
    "content": "Hello",
    "createdAt": "ISO date",
    "tokens": 2
  }
}
```

### Topic: `chat.reply.created.v1`

Producer: `chat-service`

Consumer: `activity-service`

Scenario: the assistant reply is generated.

Payload has the same structure as `chat.message.sent.v1`, but `message.role` is `assistant`.

### Topic: `system.log.created.v1`

Producers: `api-gateway`, `chat-service`, `model-service`, `activity-service`

Consumers: `activity-service`, `api-gateway`

Scenario: a service completes or fails an action.

Payload:

```json
{
  "id": "uuid",
  "timestamp": "ISO date",
  "user": "workspace:local-workspace",
  "service": "api-gateway",
  "action": "POST /v1/chat/completions",
  "status": "success",
  "correlationId": "uuid",
  "metadata": {
    "latencyMs": 20,
    "model": "gpt-5"
  }
}
```

UI actions such as creating a new chat screen, adding a provider, and selecting a model are recorded through `POST /v1/logs`. The API Gateway publishes one `system.log.created.v1` event. Activity Service consumes that event and stores it in `activity.sqlite`; API Gateway consumes the same topic for the live SSE stream.

`ActivityService.RecordLog` remains available as a direct gRPC write operation for gRPC testing and internal use. When it records a log, Activity Service also publishes `system.log.created.v1` so live clients see the event through the same stream path.

Chat flow log actions are emitted as `system.log.created.v1` payloads with the same `correlationId`: `chat_request_01_gateway_received`, `chat_message_02_user_saved`, `model_generate_03_provider_completed`, `chat_reply_04_assistant_saved`, `activity_user_message_05_kafka_consumed`, `activity_reply_06_kafka_consumed`, and `chat_response_07_gateway_returned`.

## SQLite Databases

SQLite is used because it is one of the databases allowed by the assignment.

### `chat.sqlite`

Owned by: `chat-service`

```sql
CREATE TABLE chat_requests (
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
```

### `model.sqlite`

Owned by: `model-service`

```sql
CREATE TABLE model_requests (
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
```

### `activity.sqlite`

Owned by: `activity-service`

```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  tokens INTEGER,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE logs (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  user TEXT NOT NULL,
  service TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
```

## Why The Separation Is Clear

| Part | Does | Does Not Do |
| --- | --- | --- |
| API Gateway | Exposes REST and GraphQL, calls gRPC services | Does not store business data |
| Chat Service | Handles chat workflow | Does not own conversation history |
| Model Service | Generates responses | Does not save conversations |
| Activity Service | Saves events, logs, messages, analytics | Does not generate answers |
