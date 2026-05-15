"use client";

import {
  ArcElement,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
  type ChartData,
  type ChartOptions
} from "chart.js";
import { Bar, Doughnut, Line } from "react-chartjs-2";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { getLogs, streamLogs } from "@/services/api";
import type { LogEntry, Paginated } from "@/types";

ChartJS.register(ArcElement, BarElement, CategoryScale, Filler, Legend, LinearScale, LineElement, PointElement, Tooltip);

const pageSize = 30;
const chartTextColor = "rgba(226, 232, 240, 0.72)";
const chartGridColor = "rgba(148, 163, 184, 0.13)";
const emptyLogs: Paginated<LogEntry> = { data: [], page: 1, pageSize, total: 0, totalPages: 1 };

type LogStatus = LogEntry["status"];
type StatusFilter = "" | LogStatus;
type Filters = { service: string; status: StatusFilter; date: string; search: string };
type ChatFlow = {
  type: "chat-flow";
  id: string;
  correlationId: string;
  entries: LogEntry[];
  status: LogStatus;
  startedAt: string;
  endedAt: string;
  prompt: string;
  reply: string;
  model: string;
  provider: string;
  conversationId: string;
  latencyMs: number | null;
  servicesCount: number;
};
type GroupedLogItem = ChatFlow | { type: "single"; id: string; entry: LogEntry };

const emptyFilters: Filters = { service: "", status: "", date: "", search: "" };

const chatFlowActions = new Set([
  "chat_request_01_gateway_received",
  "chat_message_02_user_saved",
  "model_generate_03_provider_completed",
  "model_generate_03_provider_failed",
  "chat_reply_04_assistant_saved",
  "activity_user_message_05_kafka_consumed",
  "activity_reply_06_kafka_consumed",
  "chat_response_07_gateway_returned",
  "chat_error_99_failed"
]);

const chatStepLabels: Record<string, string> = {
  chat_request_01_gateway_received: "Gateway received the message",
  chat_message_02_user_saved: "Chat Service saved the user prompt",
  model_generate_03_provider_completed: "Model Service got the provider reply",
  model_generate_03_provider_failed: "Model Service provider call failed",
  chat_reply_04_assistant_saved: "Chat Service saved the assistant reply",
  activity_user_message_05_kafka_consumed: "Activity Service stored the user message",
  activity_reply_06_kafka_consumed: "Activity Service stored the assistant reply",
  chat_response_07_gateway_returned: "Gateway returned the response",
  chat_error_99_failed: "Chat flow failed"
};

const services = [
  { value: "", label: "All services" },
  { value: "web-client", label: "Web Client" },
  { value: "api-gateway", label: "API Gateway" },
  { value: "chat-service", label: "Chat Service" },
  { value: "model-service", label: "Model Service" },
  { value: "activity-service", label: "Activity Service" }
] as const;

const statusLabels: Record<LogStatus, string> = {
  success: "Success",
  warning: "Warning",
  error: "Error"
};

const statusClasses: Record<LogStatus, string> = {
  success: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  warning: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  error: "border-red-400/25 bg-red-400/10 text-red-300"
};

const serviceStyles: Record<string, string> = {
  "web-client": "bg-fuchsia-400/10 text-fuchsia-200 ring-fuchsia-400/20",
  "api-gateway": "bg-sky-400/10 text-sky-200 ring-sky-400/20",
  "chat-service": "bg-violet-400/10 text-violet-200 ring-violet-400/20",
  "model-service": "bg-cyan-400/10 text-cyan-200 ring-cyan-400/20",
  "activity-service": "bg-emerald-400/10 text-emerald-200 ring-emerald-400/20"
};

const inputClass = "h-10 rounded-xl border border-border/50 bg-background px-3 text-sm text-foreground outline-none transition focus:border-primary/50 focus:bg-muted/20";

function serviceLabel(value: string) {
  return services.find((service) => service.value === value)?.label ?? value.replace(/-/g, " ");
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "Unknown time";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function shortId(value: string) {
  if (!value) return "none";
  return value.length > 14 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}

function latencyValue(entry: LogEntry) {
  const value = entry.metadata?.latencyMs;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metadataLatency(entry: LogEntry) {
  const value = latencyValue(entry);
  return value === null ? "n/a" : `${Math.round(value)} ms`;
}

function metadataString(entry: LogEntry, key: string) {
  const value = entry.metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function firstMetadataString(entries: LogEntry[], key: string) {
  for (const entry of entries) {
    const value = metadataString(entry, key);
    if (value) return value;
  }
  return "";
}

function entryStep(entry: LogEntry) {
  const value = entry.metadata?.step;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const match = entry.action.match(/_(\d{2})_/);
  return match ? Number(match[1]) : 0;
}

function isChatFlowEntry(entry: LogEntry) {
  return Boolean(entry.correlationId) && chatFlowActions.has(entry.action);
}

function statusFromEntries(entries: LogEntry[]): LogStatus {
  if (entries.some((entry) => entry.status === "error")) return "error";
  if (entries.some((entry) => entry.status === "warning")) return "warning";
  return "success";
}

function entryTime(entry: LogEntry) {
  const value = new Date(entry.timestamp).getTime();
  return Number.isFinite(value) ? value : 0;
}

function buildChatFlow(correlationId: string, entries: LogEntry[]): ChatFlow {
  const sorted = [...entries].sort((a, b) => entryStep(a) - entryStep(b) || entryTime(a) - entryTime(b));
  const latencies = sorted.map(latencyValue).filter((value): value is number => value !== null);
  const times = sorted.map(entryTime).filter((value) => value > 0);
  const startTime = times.length > 0 ? Math.min(...times) : 0;
  const endTime = times.length > 0 ? Math.max(...times) : 0;
  const servicesCount = new Set(sorted.map((entry) => entry.service)).size;

  return {
    type: "chat-flow",
    id: `chat-flow:${correlationId}`,
    correlationId,
    entries: sorted,
    status: statusFromEntries(sorted),
    startedAt: startTime ? new Date(startTime).toISOString() : sorted[0]?.timestamp ?? "",
    endedAt: endTime ? new Date(endTime).toISOString() : sorted[sorted.length - 1]?.timestamp ?? "",
    prompt: firstMetadataString(sorted, "promptPreview"),
    reply: firstMetadataString([...sorted].reverse(), "replyPreview"),
    model: firstMetadataString(sorted, "model"),
    provider: firstMetadataString(sorted, "provider"),
    conversationId: firstMetadataString(sorted, "conversationId"),
    latencyMs: latencies.length > 0 ? Math.max(...latencies) : null,
    servicesCount
  };
}

function groupLogItems(entries: LogEntry[]): GroupedLogItem[] {
  const chatGroups = new Map<string, LogEntry[]>();
  for (const entry of entries) {
    if (!isChatFlowEntry(entry)) continue;
    chatGroups.set(entry.correlationId, [...(chatGroups.get(entry.correlationId) ?? []), entry]);
  }

  const used = new Set<string>();
  const items: GroupedLogItem[] = [];

  for (const entry of entries) {
    const chatEntries = isChatFlowEntry(entry) ? chatGroups.get(entry.correlationId) : undefined;
    if (chatEntries) {
      if (used.has(entry.correlationId)) continue;
      used.add(entry.correlationId);
      items.push(buildChatFlow(entry.correlationId, chatEntries));
      continue;
    }
    items.push({ type: "single", id: entry.id, entry });
  }

  return items;
}

function metadataPreview(entry: LogEntry) {
  const metadata = entry.metadata ?? {};
  const parts: string[] = [];
  if (typeof metadata.replyPreview === "string" && metadata.replyPreview.trim()) parts.push(`reply: ${metadata.replyPreview}`);
  if (typeof metadata.promptPreview === "string" && metadata.promptPreview.trim()) parts.push(`prompt: ${metadata.promptPreview}`);
  if (typeof metadata.model === "string") parts.push(metadata.model);
  if (typeof metadata.provider === "string") parts.push(metadata.provider);
  if (Array.isArray(metadata.attachmentNames) && metadata.attachmentNames.length > 0) parts.push(`files: ${metadata.attachmentNames.join(", ")}`);
  if (typeof metadata.conversationId === "string") parts.push(shortId(metadata.conversationId));
  if (typeof metadata.mode === "string") parts.push(metadata.mode);
  if (parts.length > 0) return parts.join(" / ");
  const keys = Object.keys(metadata);
  return keys.length > 0 ? keys.slice(0, 3).join(", ") : "No metadata";
}

function StatusBadge({ status }: { status: LogStatus }) {
  return <span className={`inline-flex rounded-full border px-2 py-1 text-xs font-medium ${statusClasses[status]}`}>{statusLabels[status]}</span>;
}

function ServiceBadge({ service }: { service: string }) {
  return <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium capitalize ring-1 ${serviceStyles[service] ?? "bg-muted/40 text-muted-foreground ring-border/40"}`}>{serviceLabel(service)}</span>;
}

function StatCard({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return (
    <div className="rounded-2xl border border-border/45 bg-background p-4">
      <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-foreground">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function ChartCard({ title, detail, empty, children }: { title: string; detail: string; empty?: boolean; children: ReactNode }) {
  return (
    <div className="rounded-3xl border border-border/45 bg-background p-4">
      <div className="mb-3">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </div>
      <div className="relative h-64">
        {empty ? <div className="flex h-full items-center justify-center rounded-2xl bg-muted/20 text-center text-sm text-muted-foreground">Not enough data yet</div> : children}
      </div>
    </div>
  );
}

function DetailModal({ entry, onClose }: { entry: LogEntry | null; onClose: () => void }) {
  if (!entry) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <section className="w-full max-w-3xl overflow-hidden rounded-3xl border border-border bg-background shadow-panel" onMouseDown={(event) => event.stopPropagation()}>
        <header className="flex items-start justify-between gap-4 border-b border-border/40 p-5">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Log details</p>
            <h2 className="mt-2 truncate text-xl font-semibold text-foreground">{entry.action}</h2>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <StatusBadge status={entry.status} />
              <ServiceBadge service={entry.service} />
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-full border border-border/50 px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-muted/40 hover:text-foreground">Close</button>
        </header>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Info label="Time" value={formatDate(entry.timestamp)} />
            <Info label="Workspace" value={entry.user} />
            <Info label="Service" value={entry.service} />
            <Info label="Latency" value={metadataLatency(entry)} />
            <Info label="Correlation ID" value={entry.correlationId} wide />
          </div>

          <div className="rounded-2xl border border-border/45 bg-card/70 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Metadata</p>
              <button type="button" onClick={() => void navigator.clipboard?.writeText(JSON.stringify(entry.metadata ?? {}, null, 2))} className="rounded-xl border border-border/40 px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-muted/40 hover:text-foreground">Copy JSON</button>
            </div>
            <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-background p-3 font-mono text-xs leading-5 text-muted-foreground">{JSON.stringify(entry.metadata ?? {}, null, 2)}</pre>
          </div>
        </div>
      </section>
    </div>
  );
}

function Info({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={`rounded-2xl border border-border/40 bg-card/70 p-3 ${wide ? "sm:col-span-2" : ""}`}>
      <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-sm text-foreground">{value || "n/a"}</p>
    </div>
  );
}

function FlowInfo({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border/35 bg-card/60 p-3">
      <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-sm text-foreground" title={value || "n/a"}>{value || "n/a"}</p>
    </div>
  );
}

function stepCaption(entry: LogEntry) {
  const parts = [serviceLabel(entry.service)];
  const latency = latencyValue(entry);
  if (latency !== null) parts.push(`${Math.round(latency)} ms`);
  return parts.join(" · ");
}

function ChatFlowCard({ flow, onOpen }: { flow: ChatFlow; onOpen: (entry: LogEntry) => void }) {
  const latency = flow.latencyMs === null ? "n/a" : `${Math.round(flow.latencyMs)} ms`;
  const stepCount = new Set(flow.entries.map(entryStep)).size;

  return (
    <article className="border-b border-border/25 p-4 last:border-b-0">
      <div className="rounded-3xl border border-border/45 bg-card/55 p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={flow.status} />
              <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-1 text-xs font-medium text-primary">Chat flow</span>
              <span className="rounded-full border border-border/40 px-2 py-1 text-xs text-muted-foreground">{stepCount} steps</span>
            </div>
            <h3 className="mt-3 text-lg font-semibold text-foreground">One message through the microservices</h3>
            <p className="mt-1 text-sm text-muted-foreground">The same correlation ID is grouped here so the full request is easier to follow.</p>
          </div>
          <div className="shrink-0 text-left lg:text-right">
            <p className="text-xs text-muted-foreground">{formatDate(flow.endedAt)}</p>
            <p className="mt-1 font-mono text-[10px] text-muted-foreground/80">{shortId(flow.correlationId)}</p>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <FlowInfo label="Prompt" value={flow.prompt} />
          <FlowInfo label="Reply" value={flow.reply} />
          <FlowInfo label="Model" value={flow.model || flow.provider} />
          <FlowInfo label="Latency" value={`${latency} · ${flow.servicesCount} services`} />
        </div>
        {flow.conversationId ? <p className="mt-3 text-xs text-muted-foreground">Conversation: <span className="font-mono">{shortId(flow.conversationId)}</span></p> : null}

        <ol className="mt-4 space-y-2">
          {flow.entries.map((entry) => (
            <li key={entry.id}>
              <button type="button" onClick={() => onOpen(entry)} className="grid w-full grid-cols-[28px_1fr] gap-3 rounded-2xl border border-border/25 bg-background/60 p-3 text-left transition hover:border-primary/30 hover:bg-muted/25">
                <span className={`mt-0.5 flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold ${entry.status === "error" ? "border-red-400/30 bg-red-400/10 text-red-300" : entry.status === "warning" ? "border-amber-400/30 bg-amber-400/10 text-amber-300" : "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"}`}>{entryStep(entry)}</span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">{chatStepLabels[entry.action] ?? entry.action}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{stepCaption(entry)}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </article>
  );
}

function LogRow({ entry, onOpen }: { entry: LogEntry; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="grid w-full gap-3 border-b border-border/25 px-4 py-4 text-left transition last:border-b-0 hover:bg-muted/25 lg:grid-cols-[170px_1fr_110px] lg:items-center">
      <div>
        <p className="text-xs text-muted-foreground">{formatDate(entry.timestamp)}</p>
        <p className="mt-1 font-mono text-[10px] text-muted-foreground/80">{shortId(entry.correlationId)}</p>
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={entry.status} />
          <ServiceBadge service={entry.service} />
        </div>
        <p className="mt-2 truncate text-sm font-semibold text-foreground">{entry.action}</p>
        <p className="mt-1 truncate text-xs text-muted-foreground">{metadataPreview(entry)}</p>
      </div>
      <p className="text-xs text-muted-foreground lg:text-right">{metadataLatency(entry)}</p>
    </button>
  );
}

function totalPages(total: number) {
  return Math.max(1, Math.ceil(total / pageSize));
}

function mergeLogPages(snapshot: Paginated<LogEntry>, current: Paginated<LogEntry>, page: number) {
  if (page !== 1 || current.data.length === 0) return snapshot;
  const byId = new Map<string, LogEntry>();
  for (const entry of [...snapshot.data, ...current.data]) byId.set(entry.id, entry);
  const data = [...byId.values()].sort((a, b) => entryTime(b) - entryTime(a)).slice(0, pageSize);
  const total = Math.max(snapshot.total, current.total, data.length);
  return { ...snapshot, data, total, totalPages: totalPages(total) };
}

export function LogsPage() {
  const [draft, setDraft] = useState<Filters>(emptyFilters);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [page, setPage] = useState(1);
  const [logs, setLogs] = useState<Paginated<LogEntry>>(emptyLogs);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [live, setLive] = useState(true);
  const [streamError, setStreamError] = useState("");
  const [error, setError] = useState("");
  const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setError("");
      setRefreshing(true);
      setLoading(true);
    });

    getLogs({ service: filters.service, status: filters.status, date: filters.date, search: filters.search, page, pageSize, signal: controller.signal })
      .then((result) => {
        if (cancelled) return;
        setLogs(result);
        setLoading(false);
        setRefreshing(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load logs");
        setLoading(false);
        setRefreshing(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [filters, page, refreshKey]);

  useEffect(() => {
    if (!live) return;

    let stopped = false;
    let retryTimer: number | undefined;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!stopped) setStreamError("");
    });

    function connect() {
      void streamLogs({
        service: filters.service,
        status: filters.status,
        date: filters.date,
        search: filters.search,
        page,
        pageSize,
        signal: controller.signal,
        onSnapshot: (snapshot) => {
          if (stopped) return;
          setLogs((current) => mergeLogPages(snapshot, current, page));
          setLoading(false);
          setStreamError("");
        },
        onNewEntry: (entry) => {
          if (stopped) return;
          setStreamError("");
          setLogs((current) => {
            if (current.data.some((item) => item.id === entry.id)) return current;
            const total = current.total + 1;
            if (page !== 1) return { ...current, total, totalPages: totalPages(total) };
            return { ...current, data: [entry, ...current.data].slice(0, pageSize), total, totalPages: totalPages(total) };
          });
        },
        onError: (message) => {
          if (!stopped) setStreamError(message);
        }
      }).then(() => {
        if (!stopped && live) retryTimer = window.setTimeout(connect, 1500);
      }).catch((err) => {
        if (stopped) return;
        setStreamError(err instanceof Error ? err.message : "Live stream disconnected");
        retryTimer = window.setTimeout(connect, 2500);
      });
    }

    connect();
    return () => {
      stopped = true;
      controller.abort();
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [filters, page, live]);

  const groupedItems = useMemo(() => groupLogItems(logs.data), [logs.data]);

  const stats = useMemo(() => {
    const success = logs.data.filter((entry) => entry.status === "success").length;
    const warning = logs.data.filter((entry) => entry.status === "warning").length;
    const errors = logs.data.filter((entry) => entry.status === "error").length;
    const servicesCount = new Set(logs.data.map((entry) => entry.service)).size;
    const latencyValues = logs.data.map(latencyValue).filter((value): value is number => value !== null);
    const averageLatency = latencyValues.length > 0 ? Math.round(latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length) : null;
    const chatFlows = groupedItems.filter((item) => item.type === "chat-flow").length;
    return { success, warning, errors, servicesCount, averageLatency, chatFlows, groupedItems: groupedItems.length };
  }, [groupedItems, logs.data]);

  const statusChartData = useMemo<ChartData<"doughnut">>(() => ({
    labels: ["Success", "Warning", "Error"],
    datasets: [{
      data: [stats.success, stats.warning, stats.errors],
      backgroundColor: ["rgba(52, 211, 153, 0.78)", "rgba(251, 191, 36, 0.78)", "rgba(248, 113, 113, 0.78)"],
      borderColor: ["rgba(52, 211, 153, 1)", "rgba(251, 191, 36, 1)", "rgba(248, 113, 113, 1)"],
      borderWidth: 1,
      hoverOffset: 8
    }]
  }), [stats.errors, stats.success, stats.warning]);

  const serviceChartData = useMemo<ChartData<"bar">>(() => {
    const counts = new Map<string, number>();
    for (const entry of logs.data) counts.set(entry.service, (counts.get(entry.service) ?? 0) + 1);
    const topServices = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7);
    return {
      labels: topServices.map(([service]) => serviceLabel(service)),
      datasets: [{
        label: "Events",
        data: topServices.map(([, count]) => count),
        backgroundColor: "rgba(99, 102, 241, 0.72)",
        borderColor: "rgba(129, 140, 248, 1)",
        borderRadius: 10,
        borderWidth: 1
      }]
    };
  }, [logs.data]);

  const latencyChartData = useMemo<ChartData<"line">>(() => {
    const points = logs.data
      .map((entry) => ({ entry, value: latencyValue(entry) }))
      .filter((point): point is { entry: LogEntry; value: number } => point.value !== null)
      .sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime())
      .slice(-12);
    return {
      labels: points.map((point) => {
        const date = new Date(point.entry.timestamp);
        return Number.isNaN(date.getTime()) ? "event" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      }),
      datasets: [{
        label: "Latency ms",
        data: points.map((point) => Math.round(point.value)),
        borderColor: "rgba(34, 211, 238, 1)",
        backgroundColor: "rgba(34, 211, 238, 0.16)",
        fill: true,
        pointBackgroundColor: "rgba(34, 211, 238, 1)",
        pointBorderColor: "rgba(8, 47, 73, 1)",
        pointRadius: 3,
        tension: 0.35
      }]
    };
  }, [logs.data]);

  const doughnutOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    cutout: "68%",
    plugins: {
      legend: { position: "bottom", labels: { color: chartTextColor, boxWidth: 10, usePointStyle: true } },
      tooltip: { backgroundColor: "rgba(15, 23, 42, 0.96)", borderColor: "rgba(148, 163, 184, 0.25)", borderWidth: 1 }
    }
  }) satisfies ChartOptions<"doughnut">, []);

  const barOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { backgroundColor: "rgba(15, 23, 42, 0.96)", borderColor: "rgba(148, 163, 184, 0.25)", borderWidth: 1 }
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: chartTextColor } },
      y: { beginAtZero: true, grid: { color: chartGridColor }, ticks: { color: chartTextColor, precision: 0 } }
    }
  }) satisfies ChartOptions<"bar">, []);

  const lineOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { backgroundColor: "rgba(15, 23, 42, 0.96)", borderColor: "rgba(148, 163, 184, 0.25)", borderWidth: 1 }
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: chartTextColor, maxRotation: 0 } },
      y: { beginAtZero: true, grid: { color: chartGridColor }, ticks: { color: chartTextColor, callback: (value) => `${value}ms` } }
    }
  }) satisfies ChartOptions<"line">, []);

  const pages = useMemo(() => {
    const start = Math.max(1, page - 1);
    const end = Math.min(logs.totalPages, page + 1);
    return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
  }, [logs.totalPages, page]);

  const firstItem = logs.total === 0 ? 0 : (logs.page - 1) * logs.pageSize + 1;
  const lastItem = Math.min(logs.page * logs.pageSize, logs.total);
  const liveLabel = live ? (streamError ? "Live reconnecting" : "Live on") : "Live off";

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setFilters({ ...draft, search: draft.search.trim() });
  }

  function resetFilters() {
    setDraft(emptyFilters);
    setFilters(emptyFilters);
    setPage(1);
  }

  return (
    <section className="mx-auto w-full max-w-6xl space-y-5 px-4 pb-8 pt-4">
      <header className="rounded-3xl border border-border/50 bg-background p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">Kafka + gRPC Audit Logs</p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-foreground">System Activity</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Chat logs are grouped by correlation ID, so one message appears as a clear service flow. Each step is still persisted by Activity Service and updated live through Kafka.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setLive((value) => !value)} className={`h-10 rounded-xl px-4 text-sm font-medium transition ${live ? "bg-emerald-400/15 text-emerald-300" : "bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground"}`}>{liveLabel}</button>
            <button type="button" onClick={() => setRefreshKey((current) => current + 1)} disabled={refreshing} className="h-10 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60">{refreshing ? "Refreshing..." : "Refresh"}</button>
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Events" value={logs.total} detail="stored raw logs" />
          <StatCard label="Chat flows" value={stats.chatFlows} detail="grouped on this page" />
          <StatCard label="Issues" value={stats.errors + stats.warning} detail={`${stats.errors} errors / ${stats.warning} warnings`} />
          <StatCard label="Avg latency" value={stats.averageLatency === null ? "n/a" : `${stats.averageLatency} ms`} detail={`${stats.servicesCount} services involved`} />
        </div>
      </header>

      <form onSubmit={applyFilters} className="rounded-3xl border border-border/50 bg-background p-4">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-[190px_150px_160px_1fr_auto]">
          <select value={draft.service} onChange={(event) => setDraft((current) => ({ ...current, service: event.target.value }))} className={inputClass}>{services.map((service) => <option key={service.value} value={service.value}>{service.label}</option>)}</select>
          <select value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as StatusFilter }))} className={inputClass}><option value="">All status</option><option value="success">Success</option><option value="warning">Warning</option><option value="error">Error</option></select>
          <input type="date" value={draft.date} onChange={(event) => setDraft((current) => ({ ...current, date: event.target.value }))} className={inputClass} />
          <input value={draft.search} onChange={(event) => setDraft((current) => ({ ...current, search: event.target.value }))} placeholder="Search prompt, reply, model, provider, correlation ID" className={inputClass} />
          <div className="flex gap-2">
            <button type="submit" disabled={refreshing} className="h-10 flex-1 rounded-xl bg-foreground px-4 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-60">Search</button>
            <button type="button" onClick={resetFilters} className="h-10 rounded-xl px-4 text-sm font-medium text-muted-foreground transition hover:bg-muted/40 hover:text-foreground">Reset</button>
          </div>
        </div>
      </form>

      {error ? <div className="rounded-2xl border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-200">{error}</div> : null}
      {streamError && live ? <div className="rounded-2xl border border-amber-400/25 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">Live stream reconnecting: {streamError}</div> : null}

      <section className="grid gap-4 xl:grid-cols-3">
        <ChartCard title="Status" detail="Health of stored events." empty={logs.data.length === 0}><Doughnut data={statusChartData} options={doughnutOptions} /></ChartCard>
        <ChartCard title="Services" detail="Event volume by producer." empty={serviceChartData.labels?.length === 0}><Bar data={serviceChartData} options={barOptions} /></ChartCard>
        <ChartCard title="Latency" detail="Latest measured service times." empty={latencyChartData.labels?.length === 0}><Line data={latencyChartData} options={lineOptions} /></ChartCard>
      </section>

      <div className="overflow-hidden rounded-3xl border border-border/50 bg-background">
        <div className="flex flex-col gap-2 border-b border-border/30 px-4 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>{loading ? "Loading..." : `${stats.groupedItems} grouped items from ${logs.data.length} visible events`}</span>
          <span>Raw events {firstItem}-{lastItem} · Page {logs.page} of {logs.totalPages}</span>
        </div>

        {loading && logs.data.length === 0 ? (
          <div className="flex items-center justify-center gap-3 py-20 text-sm text-muted-foreground"><span className="h-3 w-3 animate-pulse rounded-full bg-primary" />Loading audit events...</div>
        ) : logs.data.length === 0 ? (
          <div className="py-20 text-center"><p className="text-lg font-medium text-foreground">No activity found</p><p className="mt-2 text-sm text-muted-foreground">Send a chat message, add a provider, select a model, or change filters.</p></div>
        ) : (
          <div>{groupedItems.map((item) => item.type === "chat-flow" ? <ChatFlowCard key={item.id} flow={item} onOpen={setSelectedLog} /> : <LogRow key={item.id} entry={item.entry} onOpen={() => setSelectedLog(item.entry)} />)}</div>
        )}

        {logs.totalPages > 1 ? (
          <div className="flex flex-col gap-3 border-t border-border/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">Showing {firstItem}-{lastItem}</p>
            <div className="flex items-center gap-1">
              <button type="button" disabled={page <= 1 || refreshing} onClick={() => setPage((current) => Math.max(1, current - 1))} className="h-9 rounded-xl border border-border/40 px-3 text-sm text-foreground transition hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-40">Previous</button>
              {pages.map((item) => <button key={item} type="button" disabled={refreshing} onClick={() => setPage(item)} className={`h-9 min-w-9 rounded-xl px-3 text-sm transition ${item === page ? "bg-primary text-primary-foreground" : "border border-border/40 text-muted-foreground hover:bg-muted/40 hover:text-foreground"}`}>{item}</button>)}
              <button type="button" disabled={page >= logs.totalPages || refreshing} onClick={() => setPage((current) => Math.min(logs.totalPages, current + 1))} className="h-9 rounded-xl border border-border/40 px-3 text-sm text-foreground transition hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-40">Next</button>
            </div>
          </div>
        ) : null}
      </div>

      <DetailModal entry={selectedLog} onClose={() => setSelectedLog(null)} />
    </section>
  );
}
