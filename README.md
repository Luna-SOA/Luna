# AI Chatbot

A Node.js microservices project for a chat app. Real AI replies come from any OpenAI-compatible provider you configure. Conversations and logs are stored, and the activity logs show up live in the UI.

## System Overview

The web client only talks to the API Gateway. The Gateway calls the backend services over gRPC. Kafka carries messages and logs to the Activity Service.

```mermaid
flowchart TB
  User[User] --> Web[Web Client]
  Web --> Gateway[API Gateway]
  Gateway --> Chat[Chat Service]
  Gateway --> Model[Model Service]
  Gateway --> Activity[Activity Service]
  Chat --> Model
  Chat --> Kafka[(Kafka)]
  Model --> Kafka
  Kafka --> Activity
```

| Part | What it does |
| --- | --- |
| Client | Web UI, sends HTTP requests to the Gateway |
| API Gateway | Public REST and GraphQL, gRPC clients to the services |
| Chat Service | Handles chat requests, asks Model Service for replies |
| Model Service | Calls the configured provider, lists models |
| Activity Service | Stores conversations, messages, and logs |
| Kafka | Async events between services |
| SQLite | One DB per stateful service |

## Website Workflow

The browser keeps a workspace id in localStorage and sends it as `x-luna-workspace-id` so each workspace is isolated.

```mermaid
sequenceDiagram
  participant U as User
  participant W as Web Client
  participant G as API Gateway
  participant A as Activity Service

  U->>W: Open http://localhost:3000
  W->>W: Read or create workspace id in localStorage
  W->>G: GET /v1/conversations
  G->>A: gRPC ListConversations
  A-->>G: ConversationPage
  G-->>W: Sidebar conversations
  W->>G: GET /v1/logs/stream
  G-->>W: Live SSE connection for logs page
```

## Provider And Models Workflow

The provider URL and API key are saved in the browser only, not in the backend.

```mermaid
sequenceDiagram
  participant U as User
  participant W as Web Client
  participant G as API Gateway
  participant M as Model Service
  participant P as Provider API

  U->>W: Add provider URL and API key in settings
  W->>W: Save provider in localStorage
  W->>G: POST /v1/provider/models
  G->>M: gRPC ListModels(provider)
  M->>P: GET /models
  P-->>M: Model list
  M-->>G: ModelListResponse
  G-->>W: { models: [...] }
  W->>W: User selects a model
```

## Send Message Workflow

Chat Service does not write history directly. It calls Model Service over gRPC, then publishes Kafka events that Activity Service consumes.

```mermaid
sequenceDiagram
  participant W as Web Client
  participant G as API Gateway
  participant C as Chat Service
  participant M as Model Service
  participant K as Kafka
  participant A as Activity Service

  W->>G: POST /v1/chat/completions
  G->>C: gRPC SendMessage(ChatRequest)
  C->>C: Save request in chat.sqlite
  C->>K: chat.message.sent.v1
  C->>M: gRPC Generate(GenerateRequest)
  M->>M: Save request in model.sqlite
  M-->>C: GenerateResponse
  C->>K: chat.reply.created.v1
  C->>K: system.log.created.v1
  M->>K: system.log.created.v1
  K-->>A: Consume chat.message.sent.v1
  K-->>A: Consume chat.reply.created.v1
  K-->>A: Consume system.log.created.v1
  A->>A: Save messages and logs in activity.sqlite
  C-->>G: ChatResponse
  G-->>W: Assistant message
```

## Logs Page Workflow

Logs come from Kafka events plus UI actions. Events with the same correlation ID are grouped into one flow card in the UI.

```mermaid
flowchart LR
  Gateway[API Gateway] -->|system.log.created.v1| Kafka[(Kafka)]
  Chat[Chat Service] -->|system.log.created.v1| Kafka
  Model[Model Service] -->|system.log.created.v1| Kafka
  Client[Web Client] -->|POST /v1/logs| Gateway
  Gateway -->|gRPC RecordLog| Activity
  Kafka -->|save logs| Activity[Activity Service]
  Kafka -->|live logs| Gateway
  Gateway -->|SSE /v1/logs/stream (workspaceId)| LogsPage[Logs Page Charts]
  Activity -->|SQLite| LogsDb[(activity.sqlite logs table)]
```

| Chart | Meaning |
| --- | --- |
| Status | Success, warning, and error events |
| Services | Which service produced the most events |
| Latency | Recent processing time from log metadata |

## Data Ownership
