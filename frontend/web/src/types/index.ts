export type MessageRole = "system" | "user" | "assistant";

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  tokens?: number;
}

export interface Conversation {
  id: string;
  workspaceId: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  pinned?: boolean;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  user: string;
  service: string;
  action: string;
  status: "success" | "warning" | "error";
  correlationId: string;
  metadata?: Record<string, unknown>;
}

export interface Paginated<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
