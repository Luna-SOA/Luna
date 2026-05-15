"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ClipboardEvent, type Dispatch, type DragEvent, type FormEvent, type ReactNode, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { CodePanelHost, MarkdownMessage } from "@/components/markdown-message";
import { cn } from "@/components/ui/cn";
import { ChatMatrix } from "@/components/ui/chat-matrix";
import { ScrambleText as ScrambleTextComponent } from "@/components/ui/scramble-text";
import { readAttachmentFile } from "@/services/attachment-reader";
import { getConversationMessages, sendChatMessage, type ChatAttachmentPayload, type ChatTurnPayload } from "@/services/api";
import { getSelectedModel, loadModelSettings, MODEL_SETTINGS_CHANGED } from "@/services/model-settings";
import type { ChatMessage } from "@/types";
import logo from "@/assets/logo.png";

type LocalAttachmentSummary = { name: string; size: number; method?: ChatAttachment["method"]; truncated?: boolean };
type LocalChatMessage = ChatMessage & { toolLabels?: string[]; attachmentNames?: string[]; attachmentFiles?: LocalAttachmentSummary[] };
type SubmitPrompt = (content: string, options?: { appendUser?: boolean; conversationId?: string }) => Promise<void>;

interface ChatAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  content: string;
  truncated: boolean;
  method?: "text" | "unsupported" | "paste";
  file?: File;
}

const maxAttachedFiles = 5;
const maxAttachmentChars = 1_000_000;
const largePasteChars = 1000;
const CHAT_SCROLL_BOTTOM_EVENT = "luna:chat-scroll-bottom";
const headlinePrompts: [string, ...string[]] = ["let's build", "what are we making.", "let's create something.", "let's cook"];

const suggestionButtons = [
  { label: "Brainstorm", prompt: "Brainstorm practical ideas for this.", icon: "brainstorm" },
  { label: "Explain", prompt: "Explain this in simple terms.", icon: "explain" },
  { label: "Help me code", prompt: "Help me write clean, working code.", icon: "code" }
] as const;

const moreSuggestions = [
  { label: "Summarize", prompt: "Summarize this clearly and concisely." },
  { label: "Improve writing", prompt: "Improve this writing while keeping the meaning." },
  { label: "Debug this", prompt: "Help me debug and fix this code." },
  { label: "Compare options", prompt: "Compare the options and recommend the best one." },
  { label: "Draft email", prompt: "Draft a clear, professional email for this." }
] as const;

const thinkingPhrases = ["hold up let me think real quick...", "Luna is thinking...", "working through this..."] as const;

function conversationUrl(conversationId: string) {
  return `/chat?conv=${encodeURIComponent(conversationId)}`;
}

function showConversationUrl(conversationId: string, mode: "push" | "replace" = "push") {
  if (typeof window === "undefined") return;
  if (window.location.pathname !== "/" && !window.location.pathname.startsWith("/chat")) return;
  const nextUrl = conversationUrl(conversationId);
  if (`${window.location.pathname}${window.location.search}` === nextUrl) return;
  if (mode === "replace") window.history.replaceState(null, "", nextUrl);
  else window.history.pushState(null, "", nextUrl);
}

function requestTurns(history: LocalChatMessage[], content: string): ChatTurnPayload[] {
  const turns = history
    .filter((message) => (message.role === "system" || message.role === "user" || message.role === "assistant") && message.content.trim())
    .map((message) => ({ role: message.role, content: message.content.trim() }));
  const last = turns[turns.length - 1];
  if (!last || last.role !== "user" || last.content !== content) turns.push({ role: "user", content });
  return turns.slice(-24);
}

function openSettings(tab: "models") {
  window.dispatchEvent(new CustomEvent("luna:open-settings", { detail: { tab } }));
}

function Icon({ children, className = "h-4 w-4", fill = "none" }: { children: ReactNode; className?: string; fill?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill={fill} stroke={fill === "none" ? "currentColor" : "none"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

function DotAnimation({ small = false }: { small?: boolean }) {
  return (
    <div className={cn("luna-dot-grid", small ? "h-4 w-4" : "h-[20.5px] w-[20.5px]")} aria-hidden="true">
      <ChatMatrix size={5} dotSize={small ? 2 : 2.5} gap={2} />
    </div>
  );
}

function ScrambleText({ text }: { text: string }) {
  return (
    <span style={{ transform: "none" }}>
      <ScrambleTextComponent text={text} isLoading={false} showShimmer={false} />
    </span>
  );
}

function SuggestionIcon({ name }: { name: (typeof suggestionButtons)[number]["icon"] }) {
  if (name === "code") return <Icon><path d="m16 18 6-6-6-6" /><path d="m8 6-6 6 6 6" /></Icon>;
  if (name === "explain") return <Icon><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z" /><path d="M8 7h8" /><path d="M8 11h6" /></Icon>;
  return <Icon><path d="M9 18h6" /><path d="M10 22h4" /><path d="M12 2a7 7 0 0 0-4 12.74V17h8v-2.26A7 7 0 0 0 12 2Z" /></Icon>;
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizedFile(file: File, fallbackName: string) {
  if (file.name) return file;
  return new File([file], fallbackName, { type: file.type || "application/octet-stream", lastModified: file.lastModified || Date.now() });
}

function attachmentPlaceholders(files: File[]): ChatAttachment[] {
  return files.map((file) => ({
    id: crypto.randomUUID(),
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    content: "",
    truncated: false,
    file,
  }));
}

function readAttachments(fileList: FileList | null): ChatAttachment[] {
  const files = Array.from(fileList ?? []).slice(0, maxAttachedFiles).map((file, index) => normalizedFile(file, `attached-file-${index + 1}`));
  return attachmentPlaceholders(files);
}

function clipboardFiles(event: ClipboardEvent<HTMLTextAreaElement>) {
  const files: File[] = [];
  const items = Array.from(event.clipboardData.items ?? []);

  for (const item of items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (!file) continue;
    const extension = file.type.split("/")[1]?.replace("jpeg", "jpg") || "bin";
    files.push(normalizedFile(file, `pasted-file-${files.length + 1}.${extension}`));
  }

  return files;
}

function dragHasFiles(event: DragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function createPastedAttachment(text: string): ChatAttachment {
  const content = text.slice(0, maxAttachmentChars);
  return {
    id: crypto.randomUUID(),
    name: `pasted-text-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`,
    type: "text/plain",
    size: new Blob([text]).size,
    content,
    truncated: text.length > maxAttachmentChars,
    method: "paste",
  };
}

function attachmentMethodLabel(method?: ChatAttachment["method"]) {
  if (method === "unsupported") return "Unsupported";
  if (method === "paste") return "Pasted text";
  return "Text";
}

function cleanUrlToken(value: string) {
  return value.replace(/[\])}>,.!?;:'"]+$/g, "");
}

function detectedWebUrls(value: string) {
  const urls = new Set<string>();
  const pattern = /https?:\/\/[^\s<>{}"`]+/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value)) !== null && urls.size < 3) {
    const candidate = cleanUrlToken(match[0]);
    try {
      urls.add(new URL(candidate).toString());
    } catch {}
  }

  return [...urls];
}

function urlHostLabel(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

function wantsWebSearch(value: string) {
  return /^\s*search\b/i.test(value) || /\b(?:search\s+(?:the\s+)?(?:web|internet|online)|web\s+search|search\s+online|look\s+up\s+online)\b/i.test(value);
}

function shouldAutoEnableWebSearch(value: string) {
  return wantsWebSearch(value);
}

function isInsideScrollLockedVisual(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest('[data-luna-scroll-lock="true"]'));
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

function parseThinkingContent(content: string | null | undefined) {
  if (typeof content !== "string") {
    return { active: false, answer: "", hasThinking: false, thoughts: [] as string[] };
  }
  const thoughts: string[] = [];
  let answer = "";
  let cursor = 0;
  let active = false;
  const lower = content.toLowerCase();

  while (cursor < content.length) {
    const openIndex = lower.indexOf(THINK_OPEN, cursor);
    if (openIndex === -1) {
      answer += content.slice(cursor);
      break;
    }

    answer += content.slice(cursor, openIndex);
    const thoughtStart = openIndex + THINK_OPEN.length;
    const closeIndex = lower.indexOf(THINK_CLOSE, thoughtStart);
    if (closeIndex === -1) {
      const thought = content.slice(thoughtStart).trim();
      if (thought) thoughts.push(thought);
      active = true;
      break;
    }

    const thought = content.slice(thoughtStart, closeIndex).trim();
    if (thought) thoughts.push(thought);
    cursor = closeIndex + THINK_CLOSE.length;
  }

  return {
    active,
    answer: answer.replace(/\n{3,}/g, "\n\n").trimStart(),
    hasThinking: thoughts.length > 0 || active,
    thoughts,
  };
}

type AgentActivity = {
  id: string;
  kind: "tool" | "output" | "status" | "code";
  name: string;
  status?: string;
  input?: string;
  output?: string;
  done: boolean;
  failed?: boolean;
};

type WebSourceSummary = {
  id: string;
  title: string;
  url: string;
  domain: string;
  snippet: string;
  image?: string;
};

type WebImageSummary = {
  id: string;
  title: string;
  url: string;
  image: string;
};

function decodeHtml(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseAttributes(value: string) {
  const attrs: Record<string, string> = {};
  const pattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value)) !== null) {
    const key = match[1];
    if (!key) continue;
    attrs[key] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }

  return attrs;
}

function formatActivityValue(value: string) {
  const trimmed = decodeHtml(value).trim();
  if (!trimmed) return "";

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string") return formatActivityValue(parsed);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return trimmed;
  }
}

function activityFailedFromAttrs(attrs: Record<string, string>) {
  return attrs.failed === "true";
}

const activityAttributeNames = new Set(["id", "name", "status", "done", "failed", "arguments", "input", "result"]);
const detailActivityTypes = new Set(["tool_calls", "code_interpreter", "reasoning", "status"]);

function hasActivityAttrs(attrs: Record<string, string>) {
  return Object.keys(attrs).some((key) => activityAttributeNames.has(key));
}

function isActivityTag(tag: string, attrs: Record<string, string>) {
  if (tag === "details") return Boolean(attrs.type && detailActivityTypes.has(attrs.type));
  return hasActivityAttrs(attrs);
}

function stripDanglingActivityMarkup(value: string) {
  return value.replace(/<(tool|output|status|code|details)(?:\s+([^>]*))?[\s\S]*$/i, (match, tag: string, rawAttrs = "") => {
    return isActivityTag(tag.toLowerCase(), parseAttributes(rawAttrs)) ? "" : match;
  });
}

function hostnameFromUrl(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

function faviconForUrl(value: string) {
  try {
    const url = new URL(value);
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.hostname)}&sz=32`;
  } catch {
    return "";
  }
}

function sourcesFromEvents(events: AgentActivity[]) {
  const sources: WebSourceSummary[] = [];
  const seen = new Set<string>();

  for (const event of events) {
    if (!event.output || !/web search|browse url/i.test(event.name)) continue;
    const blocks = event.output.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
    for (const block of blocks) {
      const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
      const heading = /^\[(S\d+)\]\s+(.+)$/i.exec(lines[0] ?? "");
      const url = lines.find((line, index) => index > 0 && /^https?:\/\//i.test(line));
      const image = lines.map((line) => /^Image:\s*(https?:\/\/\S+)$/i.exec(line)?.[1]).find(Boolean);
      if (!heading || !url || seen.has(url)) continue;
      seen.add(url);
      sources.push({
        id: heading[1] ?? `S${sources.length + 1}`,
        title: heading[2] ?? url,
        url,
        domain: hostnameFromUrl(url),
        snippet: lines.filter((line) => line !== url && line !== lines[0] && !/^Image:\s*/i.test(line)).join(" "),
        image,
      });
    }
  }

  return sources;
}

function imagesFromEvents(events: AgentActivity[]) {
  const images: WebImageSummary[] = [];
  const seen = new Set<string>();

  for (const event of events) {
    if (!event.output || !/web images/i.test(event.name)) continue;
    const blocks = event.output.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
    for (const block of blocks) {
      const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
      const heading = /^\[(I\d+)\]\s+(.+)$/i.exec(lines[0] ?? "");
      const url = lines.find((line, index) => index > 0 && /^https?:\/\//i.test(line));
      const image = lines.map((line) => /^Image:\s*(https?:\/\/\S+)$/i.exec(line)?.[1]).find(Boolean);
      if (!heading || !url || !image || seen.has(image)) continue;
      seen.add(image);
      images.push({ id: heading[1] ?? `I${images.length + 1}`, title: heading[2] ?? url, url, image });
    }
  }

  return images;
}

function activityNameFromContent(content: string | null | undefined) {
  if (typeof content !== "string") return "tool";
  const firstLine = content.trim().split("\n").find(Boolean)?.trim() ?? "tool";
  return firstLine.length > 72 ? `${firstLine.slice(0, 72)}...` : firstLine;
}

function parseAgentActivity(content: string | null | undefined): { answer: string; events: AgentActivity[] } {
  if (typeof content !== "string") return { answer: "", events: [] };
  const events: AgentActivity[] = [];
  const eventsByKey = new Map<string, AgentActivity>();
  let withoutDetails = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  const detailsPattern = /<details\s+([^>]*)>([\s\S]*?)(?:<\/details>|$)/gi;

  function upsertEvent(event: AgentActivity, key?: string) {
    if (key && eventsByKey.has(key)) {
      const existing = eventsByKey.get(key)!;
      existing.kind = event.kind;
      existing.name = event.name || existing.name;
      existing.status = event.status || existing.status;
      existing.input = event.input || existing.input;
      existing.output = event.output || existing.output;
      existing.done = event.done;
      existing.failed = event.failed;
      return existing;
    }

    events.push(event);
    if (key) eventsByKey.set(key, event);
    return event;
  }

  while ((match = detailsPattern.exec(content)) !== null) {
    withoutDetails += content.slice(cursor, match.index);
    const attrs = parseAttributes(match[1] ?? "");
    const type = attrs.type;
    const body = formatActivityValue(match[2] ?? "");

    if (!type || !detailActivityTypes.has(type)) {
      withoutDetails += match[0];
    } else if (type === "tool_calls" || type === "code_interpreter") {
      const output = formatActivityValue(attrs.result ?? body);
      const eventName = attrs.name || (type === "code_interpreter" ? "code interpreter" : "tool");
      upsertEvent({
        id: `detail-${events.length}-${match.index}`,
        kind: type === "code_interpreter" ? "code" : "tool",
        name: eventName,
        status: attrs.status,
        input: formatActivityValue(attrs.arguments ?? ""),
        output,
        done: attrs.done ? attrs.done === "true" : Boolean(output),
        failed: activityFailedFromAttrs(attrs)
      }, attrs.id || eventName);
    } else if (type === "reasoning" || type === "status") {
      const eventName = attrs.name || (type === "reasoning" ? "reasoning" : "status");
      upsertEvent({
        id: `detail-${events.length}-${match.index}`,
        kind: "status",
        name: eventName,
        status: attrs.status,
        output: body,
        done: attrs.done ? attrs.done === "true" : true,
      }, attrs.id || eventName);
    } else {
      withoutDetails += match[0];
    }

    cursor = detailsPattern.lastIndex;
  }
  withoutDetails += content.slice(cursor);

  let answer = "";
  cursor = 0;
  const tagPattern = /<(tool|output|status|code)(?:\s+([^>]*))?>[\r\n]*([\s\S]*?)(?:<\/\1>|$)/gi;

  while ((match = tagPattern.exec(withoutDetails)) !== null) {
    answer += withoutDetails.slice(cursor, match.index);
    const tag = (match[1] ?? "status").toLowerCase();
    const attrs = parseAttributes(match[2] ?? "");
    const body = formatActivityValue(match[3] ?? "");
    const tagClosed = new RegExp(`</${tag}>\\s*$`, "i").test(match[0]);

    if (!isActivityTag(tag, attrs)) {
      answer += match[0];
      cursor = tagPattern.lastIndex;
      continue;
    }

    if (tag === "output") {
      const outputDone = tagClosed && (attrs.done ? attrs.done === "true" : true);
      const outputStatus = outputDone ? attrs.status : "Streaming output";
      const outputFailed = outputDone && activityFailedFromAttrs(attrs);
      const outputKey = attrs.id || attrs.name;
      const lastTool = outputKey && eventsByKey.has(outputKey)
        ? eventsByKey.get(outputKey)
        : [...events].reverse().find((event) => (event.kind === "tool" || event.kind === "code") && !event.done);
      if (lastTool) {
        lastTool.output = body;
        lastTool.status = outputStatus || lastTool.status;
        lastTool.done = outputDone;
        lastTool.failed = outputFailed;
      } else {
        const eventName = attrs.name || "tool output";
        upsertEvent({ id: `tag-${events.length}-${match.index}`, kind: "output", name: eventName, status: outputStatus, output: body, done: outputDone, failed: outputFailed }, attrs.id || eventName);
      }
    } else {
      const eventName = attrs.name || activityNameFromContent(body);
      const eventDone = tagClosed && (attrs.done ? attrs.done === "true" : tag === "status");
      upsertEvent({
        id: `tag-${events.length}-${match.index}`,
        kind: tag === "code" ? "code" : tag === "tool" ? "tool" : "status",
        name: eventName,
        status: attrs.status,
        input: formatActivityValue(attrs.arguments ?? attrs.input ?? ""),
        output: tag === "status" ? body : attrs.result ? formatActivityValue(attrs.result) : undefined,
        done: eventDone,
        failed: activityFailedFromAttrs(attrs)
      }, attrs.id || eventName);
    }

    cursor = tagPattern.lastIndex;
  }
  answer += withoutDetails.slice(cursor);

  return { answer: stripDanglingActivityMarkup(answer).replace(/\n{3,}/g, "\n\n").trim(), events };
}

function ActivityPreview({ label, value }: { label: string; value: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const limit = 1100;
  const lineLimit = 18;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const lines = trimmed.split("\n");
  const clipped = trimmed.length > limit || lines.length > lineLimit;
  const preview = lines.slice(0, lineLimit).join("\n").slice(0, limit);
  const shown = expanded || !clipped ? trimmed : preview;

  async function copyValue() {
    try {
      await navigator.clipboard.writeText(trimmed);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {}
  }

  return (
    <div className="luna-activity-preview overflow-hidden rounded-2xl border border-border/35 bg-background/55">
      <div className="flex items-center justify-between gap-2 border-b border-border/30 px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">{label}</p>
        <button type="button" onClick={copyValue} className="rounded-full border border-border/35 px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition hover:bg-muted/40 hover:text-foreground">{copied ? "Copied" : "Copy"}</button>
      </div>
      <div className="relative p-3">
        <pre className={`scrollbar-thin overflow-auto overscroll-contain whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground/85 ${expanded ? "max-h-[70vh]" : "max-h-72"}`}><ActivitySyntax value={shown} /></pre>
        {!expanded && clipped ? <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-background/95 to-transparent" /> : null}
      </div>
      {clipped ? (
        <div className="border-t border-border/25 px-3 py-2">
          <button type="button" onClick={() => setExpanded((current) => !current)} className="inline-flex items-center gap-1.5 rounded-full border border-border/45 px-2.5 py-1 text-xs font-medium text-primary transition hover:bg-primary/10">
            {expanded ? "Show less" : `Show all ${trimmed.length.toLocaleString()} chars`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ActivitySyntax({ value }: { value: string }) {
  const pattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:https?:\/\/[^\s]+|ECharts|JSON|valid|validated|passed|failed|error|warning|none|true|false|null)\b|\b\d+(?:\.\d+)?%?\b|[{}[\]():,])/gi;
  const parts: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value)) !== null) {
    if (match.index > cursor) parts.push(value.slice(cursor, match.index));
    const token = match[0];
    const lower = token.toLowerCase();
    const className = token.startsWith("http")
      ? "text-primary underline decoration-primary/30 underline-offset-2"
      : token.startsWith("\"") || token.startsWith("'") || token.startsWith("`")
        ? "text-emerald-500 dark:text-emerald-300"
        : /^(valid|validated|passed|true)$/i.test(token)
          ? "text-emerald-500 dark:text-emerald-300"
          : /^(failed|error)$/i.test(token)
            ? "text-danger"
            : /^(warning)$/i.test(token)
              ? "text-amber-500"
              : /^(json|echarts)$/i.test(token)
                ? "text-primary"
                : /^(none|null|false)$/i.test(lower)
                  ? "text-muted-foreground"
                  : /^\d/.test(token)
                    ? "text-sky-500 dark:text-sky-300"
                    : "text-muted-foreground/80";
    parts.push(<span key={`${match.index}-${token}`} className={className}>{token}</span>);
    cursor = match.index + token.length;
  }

  if (cursor < value.length) parts.push(value.slice(cursor));
  return <>{parts}</>;
}

function CopyActionButton({ value, label = "Copy", className = "inline-flex h-6 w-6 items-center justify-center rounded-md transition hover:bg-muted/50 hover:text-foreground" }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {}
  }

  return (
    <button type="button" onClick={handleCopy} className={cn(className, copied && "bg-muted/60 text-foreground")} title={copied ? "Copied" : label} aria-label={copied ? "Copied" : label}>
      {copied ? <Icon className="h-3.5 w-3.5"><path d="M20 6 9 17l-5-5" /></Icon> : <Icon className="h-3.5 w-3.5"><rect width="14" height="14" x="8" y="8" rx="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></Icon>}
    </button>
  );
}

function agentKindLabel(kind: AgentActivity["kind"]) {
  if (kind === "code") return "Code";
  if (kind === "status") return "Status";
  if (kind === "output") return "Output";
  return "Tool";
}

function AgentKindIcon({ kind }: { kind: AgentActivity["kind"] }) {
  if (kind === "code") return <Icon className="h-3.5 w-3.5"><path d="m16 18 6-6-6-6" /><path d="m8 6-6 6 6 6" /></Icon>;
  if (kind === "status") return <Icon className="h-3.5 w-3.5"><circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" /></Icon>;
  if (kind === "output") return <Icon className="h-3.5 w-3.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></Icon>;
  return <Icon className="h-3.5 w-3.5"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.1-3.1a6 6 0 0 1-7.9 7.9l-5.6 5.6a2.1 2.1 0 0 1-3-3l5.6-5.6a6 6 0 0 1 7.9-7.9l-3.1 3.1Z" /></Icon>;
}

function AgentStateMark({ status, large = false }: { status: "running" | "done" | "failed"; large?: boolean }) {
  return (
    <span data-status={status} data-large={large ? "true" : "false"} className={cn("luna-agent-state flex shrink-0 items-center justify-center rounded-full", large ? "h-10 w-10" : "h-5 w-5")}> 
      {status === "running" ? <DotAnimation small /> : status === "done" ? <Icon className={large ? "h-4 w-4" : "h-3 w-3"}><path d="M20 6 9 17l-5-5" /></Icon> : <Icon className={large ? "h-4 w-4" : "h-3 w-3"}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Icon>}
    </span>
  );
}

function AgentActivityItem({ event, index }: { event: AgentActivity; index: number }) {
  const status = event.failed ? "failed" : event.done ? "done" : "running";
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const expanded = manualOpen ?? false;
  const statusLabel = status === "running" ? event.status || "Executing" : event.failed ? event.status || "Needs attention" : event.status || "Complete";

  return (
    <article data-status={status} className="luna-agent-item relative pl-7">
      <span className="absolute left-0 top-3"><AgentStateMark status={status} /></span>
      <div className={cn("luna-agent-step-card overflow-hidden rounded-2xl border bg-background/45 transition", status === "failed" ? "border-danger/30" : status === "running" ? "border-primary/30" : "border-border/35")}>
        <button type="button" onClick={() => setManualOpen((value) => !(value ?? expanded))} className="flex w-full items-center gap-3 px-3 py-2.5 text-left">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl border border-border/35 bg-card/75 text-muted-foreground">
            <AgentKindIcon kind={event.kind} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              <span>{agentKindLabel(event.kind)}</span>
              <span className="h-1 w-1 rounded-full bg-muted-foreground/40" />
              <span>Step {index + 1}</span>
            </span>
            <span className="mt-0.5 block truncate text-sm font-semibold text-foreground">{event.name}</span>
            <span className="luna-agent-status-text mt-0.5 block truncate text-xs text-muted-foreground">{statusLabel}</span>
          </span>
          <span className={cn("hidden rounded-full border px-2 py-0.5 text-[10px] font-medium sm:inline-flex", status === "failed" ? "border-danger/30 bg-danger/10 text-danger" : status === "done" ? "border-success/30 bg-success/10 text-success" : "border-primary/30 bg-primary/10 text-primary")}>{status === "running" ? "Live" : status === "done" ? "Done" : "Issue"}</span>
          <Icon className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", expanded ? "rotate-180" : "")}><path d="m6 9 6 6 6-6" /></Icon>
        </button>
        {expanded ? (
          <div className="luna-agent-body space-y-2 border-t border-border/25 p-3 pt-2.5">
            {event.input ? <ActivityPreview label="Input" value={event.input} /> : null}
            {event.output ? <ActivityPreview label={event.kind === "status" ? "Detail" : "Output"} value={event.output} /> : null}
            {!event.input && !event.output ? <p className="rounded-2xl border border-border/25 bg-muted/10 px-3 py-2 text-xs text-muted-foreground">Waiting for Luna to stream details...</p> : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function AgentActivityPanel({ events, streaming = false }: { events: AgentActivity[]; streaming?: boolean }) {
  const hasPendingEvent = events.some((event) => !event.done);
  const pending = streaming || hasPendingEvent;
  const [open, setOpen] = useState(false);
  if (events.length === 0) return null;
  const failed = events.filter((event) => event.failed).length;
  const completed = events.filter((event) => event.done && !event.failed).length;
  const activeEvent = events.find((event) => !event.done);
  const headerStatus = failed ? "failed" : pending ? "running" : "done";
  const label = "Agent activity";
  const summary = activeEvent?.status || (pending ? "Luna is working through the steps" : failed ? `${failed} issue${failed === 1 ? "" : "s"} found` : `${completed} step${completed === 1 ? "" : "s"} complete`);

  return (
    <section data-pending={pending ? "true" : "false"} className="luna-agent-panel mb-4 overflow-hidden rounded-3xl border border-border/45 bg-card/50 shadow-sm backdrop-blur-md">
      <button type="button" onClick={() => setOpen((value) => !value)} className="relative flex min-h-[64px] w-full items-center gap-3 px-4 py-3 text-left">
        <span className="luna-agent-orb shrink-0">
          <AgentStateMark status={headerStatus} large />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-foreground">{label}</span>
          <span className="mt-0.5 block min-h-4 truncate text-xs text-muted-foreground">{summary}</span>
        </span>
        <span className="hidden shrink-0 items-center gap-1.5 sm:flex">
          <span className="rounded-full border border-border/35 bg-background/55 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">{events.length} total</span>
          {failed ? <span className="rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-medium text-danger">{failed} failed</span> : null}
        </span>
        <Icon className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open ? "rotate-180" : "")}><path d="m6 9 6 6 6-6" /></Icon>
      </button>
      {open ? (
        <div className="luna-agent-timeline space-y-3 border-t border-border/30 px-4 pb-4 pt-3">
          {events.map((event, index) => <AgentActivityItem key={event.id} event={event} index={index} />)}
        </div>
      ) : null}
    </section>
  );
}

function SourceIcon({ source }: { source: WebSourceSummary }) {
  const favicon = faviconForUrl(source.url);
  return favicon ? (
    <span className="block h-full w-full rounded-full bg-muted bg-cover bg-center" style={{ backgroundImage: `url(${favicon})` }} aria-hidden="true" />
  ) : (
    <span className="flex h-full w-full items-center justify-center rounded-full bg-primary/10 text-[9px] font-semibold text-primary">{source.id.replace(/^S/i, "")}</span>
  );
}

function SourcesPanel({ sources, onClose }: { sources: WebSourceSummary[]; onClose: () => void }) {
  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[80] pointer-events-none">
      <button type="button" aria-label="Close sources" className="absolute inset-0 bg-background/30 backdrop-blur-[2px] pointer-events-auto" onClick={onClose} />
      <aside className="luna-sources-panel pointer-events-auto absolute bottom-3 left-3 right-3 top-16 flex flex-col overflow-hidden rounded-3xl border border-border/55 bg-background/95 shadow-panel backdrop-blur-md md:bottom-6 md:left-auto md:right-6 md:top-20 md:w-[390px]">
        <div className="flex shrink-0 items-center justify-between gap-3 px-5 py-4">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl text-primary"><Icon><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 0 20" /><path d="M12 2a15.3 15.3 0 0 0 0 20" /></Icon></span>
            <h2 className="truncate text-base font-semibold text-foreground">Sources</h2>
            <span className="flex min-w-5 items-center justify-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{sources.length}</span>
          </div>
          <button type="button" onClick={onClose} className="rounded-full p-2 text-muted-foreground transition hover:bg-muted/60 hover:text-foreground" aria-label="Close sources"><Icon><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Icon></button>
        </div>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
          {sources.map((source, index) => (
            <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="luna-source-card group flex gap-3 rounded-2xl px-3 py-3 transition hover:bg-muted/45">
              <span className="mt-0.5 h-5 w-5 shrink-0 overflow-hidden rounded-full"><SourceIcon source={source} /></span>
              <span className="min-w-0 flex-1">
                <span className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="truncate group-hover:text-foreground">{source.domain}</span>
                  <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{source.id || `S${index + 1}`}</span>
                </span>
                <span className="line-clamp-2 text-sm font-semibold leading-snug text-foreground transition group-hover:text-primary">{source.title}</span>
                {source.snippet ? <span className="luna-source-snippet mt-1.5 block text-xs leading-5 text-muted-foreground/80">{source.snippet}</span> : null}
              </span>
            </a>
          ))}
        </div>
      </aside>
    </div>,
    document.body
  );
}

function SourceImagePreview({ sources, images = [] }: { sources: WebSourceSummary[]; images?: WebImageSummary[] }) {
  const imageSources = images.length > 0
    ? images.slice(0, 8)
    : sources.filter((source) => source.image).slice(0, 8).map((source) => ({ id: source.id, title: source.title, url: source.url, image: source.image! }));
  if (imageSources.length === 0) return null;

  return (
    <div className="luna-source-images -mx-1 mt-4 overflow-hidden">
      <div className="scrollbar-thin flex gap-2 overflow-x-auto overscroll-contain px-1 pb-1">
        {imageSources.map((source) => (
          <a key={`${source.id}-${source.image}`} href={source.url} target="_blank" rel="noreferrer" aria-label={source.title} className="group relative h-24 w-28 shrink-0 overflow-hidden rounded-2xl border border-border/45 bg-muted md:h-28 md:w-32">
            <span className="absolute inset-0 bg-cover bg-center transition duration-300 group-hover:scale-105" style={{ backgroundImage: `url(${source.image})` }} aria-hidden="true" />
            <span className="absolute inset-0 bg-gradient-to-t from-background/20 via-transparent to-transparent opacity-0 transition group-hover:opacity-100" />
          </a>
        ))}
      </div>
    </div>
  );
}

function SourceReferences({ sources }: { sources: WebSourceSummary[] }) {
  const [open, setOpen] = useState(false);
  if (sources.length === 0) return null;
  const previewSources = sources.slice(0, 4);

  return (
    <div className="luna-source-strip mt-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <button type="button" onClick={() => setOpen(true)} className="group inline-flex items-center gap-2 rounded-full border border-border/45 bg-background/70 px-3 py-1.5 text-xs font-medium text-foreground shadow-sm transition hover:border-primary/35 hover:bg-muted/45">
        <span className="flex -space-x-1.5">
          {previewSources.map((source, index) => (
            <span key={source.url} className="relative h-5 w-5 overflow-hidden rounded-full border-2 border-background bg-card transition-transform group-hover:-translate-y-0.5" style={{ zIndex: previewSources.length - index }}>
              <SourceIcon source={source} />
            </span>
          ))}
        </span>
        <span>Sources</span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{sources.length}</span>
      </button>
      {open ? <SourcesPanel sources={sources} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

const AssistantAnswer = memo(function AssistantAnswer({ content, afterAgent }: { content: string; afterAgent?: ReactNode }) {
  const parsed = parseAgentActivity(content);
  const sources = sourcesFromEvents(parsed.events);
  const images = imagesFromEvents(parsed.events);
  if (parsed.events.length === 0) return <>{afterAgent}<MarkdownMessage content={content} /></>;

  return (
    <div className="luna-response-flow">
      <div className="luna-phase luna-phase-agent"><AgentActivityPanel events={parsed.events} /></div>
      {afterAgent}
      {parsed.answer ? <div className="luna-phase luna-phase-answer"><MarkdownMessage content={parsed.answer} /></div> : null}
      <div className="luna-phase luna-phase-sources"><SourceImagePreview sources={sources} images={images} /><SourceReferences sources={sources} /></div>
    </div>
  );
});

function formatThoughtDuration(startedAt?: string, endedAt?: string) {
  const start = startedAt ? new Date(startedAt).getTime() : Number.NaN;
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const duration = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;

  if (duration < 1000) return "under a second";
  const seconds = Math.round(duration / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function ThinkingStatus({ label, className = "mb-8" }: { label: string; className?: string }) {
  const [phraseIndex, setPhraseIndex] = useState(0);
  const canCycle = label === "Luna is thinking...";

  useEffect(() => {
    if (!canCycle) return;
    const interval = window.setInterval(() => setPhraseIndex((current) => (current + 1) % thinkingPhrases.length), 3500);
    return () => window.clearInterval(interval);
  }, [canCycle]);

  const text = canCycle ? thinkingPhrases[phraseIndex] ?? thinkingPhrases[0] : label;

  return (
    <div className={`luna-thinking-line ${className} flex items-center gap-3 text-left text-sm`}>
      <DotAnimation small />
      <span key={text} className="luna-thinking-text">
        <ScrambleTextComponent text={text} isLoading={canCycle} showShimmer={true} />
      </span>
    </div>
  );
}

function LiveThoughtPreview({ thoughts }: { thoughts: string[] }) {
  const content = thoughts.join("\n\n").trim();
  if (!content) return null;

  return (
    <div className="mb-6 rounded-lg border border-border/30 bg-muted/5 p-3 text-left text-sm leading-6 text-muted-foreground">
      <p className="whitespace-pre-wrap">{content}</p>
    </div>
  );
}

function ThinkingBlock({ thoughts, durationLabel }: { thoughts: string[]; durationLabel: string }) {
  const [expanded, setExpanded] = useState(false);
  const content = thoughts.join("\n\n").trim();

  return (
    <div className="mb-3">
      <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} className="group flex w-full items-center justify-between gap-3 text-left text-sm text-muted-foreground transition-colors hover:text-foreground">
        <span>Thought for {durationLabel}</span>
        <Icon className={`h-4 w-4 shrink-0 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}><path d="m6 9 6 6 6-6" /></Icon>
      </button>
      {expanded ? (
        <div className="animate-accordion-down overflow-hidden pt-3 text-sm leading-6 text-muted-foreground">
          {(content || "Thinking through the response...").split(/\n{2,}/).map((paragraph, index) => (
            <p key={index} className="whitespace-pre-wrap first:mt-0 last:mb-0">{paragraph}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const MessageThread = memo(function MessageThread({ messages, loading, thinkingMessage, onEditUserMessage, onDeleteMessage, onRegenerateMessage }: { messages: LocalChatMessage[]; loading: boolean; thinkingMessage: string; onEditUserMessage: (message: LocalChatMessage, index: number) => void; onDeleteMessage: (message: LocalChatMessage, index: number) => void; onRegenerateMessage: (message: LocalChatMessage, index: number) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const hideScrollButtonRef = useRef<number | null>(null);
  const userScrolledRef = useRef(false);
  const manualScrollLockUntilRef = useRef(0);
  const previousMessageCountRef = useRef(0);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const latestMessage = messages[messages.length - 1];

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior });
  }, []);

  const slideToBottom = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    window.requestAnimationFrame(() => {
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
      window.setTimeout(() => container.scrollTo({ top: container.scrollHeight, behavior: "smooth" }), 120);
    });
  }, []);

  useEffect(() => {
    const container = scrollRef.current;
    const content = contentRef.current;
    if (!container) return;

    const handleScroll = () => {
      window.requestAnimationFrame(() => {
        const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
        const shouldShow = !nearBottom && container.scrollHeight > container.clientHeight + 50;
        setShowScrollButton((current) => current === shouldShow ? current : shouldShow);

        if (shouldShow) {
          if (hideScrollButtonRef.current) window.clearTimeout(hideScrollButtonRef.current);
          hideScrollButtonRef.current = window.setTimeout(() => setShowScrollButton(false), 3000);
        }

        if (nearBottom && Date.now() > manualScrollLockUntilRef.current) {
          userScrolledRef.current = false;
        }
      });
    };

    const onManualScroll = (event: WheelEvent | TouchEvent) => {
      const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
      if (event instanceof WheelEvent && event.deltaY < 0) {
        userScrolledRef.current = true;
        manualScrollLockUntilRef.current = Date.now() + 900;
      }
      if (event instanceof TouchEvent) {
        userScrolledRef.current = true;
        manualScrollLockUntilRef.current = Date.now() + 900;
      }
      if (nearBottom && Date.now() > manualScrollLockUntilRef.current) {
        userScrolledRef.current = false;
      }
    };

    const observer = new ResizeObserver(handleScroll);
    observer.observe(container);
    if (content) observer.observe(content);
    container.addEventListener("scroll", handleScroll);
    container.addEventListener("wheel", onManualScroll, { passive: true });
    container.addEventListener("touchmove", onManualScroll, { passive: true });
    handleScroll();

    return () => {
      observer.disconnect();
      container.removeEventListener("scroll", handleScroll);
      container.removeEventListener("wheel", onManualScroll);
      container.removeEventListener("touchmove", onManualScroll);
      if (hideScrollButtonRef.current) window.clearTimeout(hideScrollButtonRef.current);
    };
  }, []);

  useEffect(() => {
    function onScrollBottom() {
      userScrolledRef.current = false;
      manualScrollLockUntilRef.current = 0;
      setShowScrollButton(false);
      slideToBottom();
    }

    window.addEventListener(CHAT_SCROLL_BOTTOM_EVENT, onScrollBottom);
    return () => window.removeEventListener(CHAT_SCROLL_BOTTOM_EVENT, onScrollBottom);
  }, [slideToBottom]);

  useEffect(() => {
    if (loading && !userScrolledRef.current) scrollToBottom();
  }, [latestMessage?.content, loading, scrollToBottom]);

  useEffect(() => {
    if (messages.length > previousMessageCountRef.current && latestMessage?.role === "user") {
      userScrolledRef.current = false;
      setShowScrollButton(false);
    }
    previousMessageCountRef.current = messages.length;
    if (!userScrolledRef.current) window.setTimeout(slideToBottom, 100);
  }, [messages.length, latestMessage?.role, slideToBottom]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const wheelOptions = { passive: false, capture: true } as const;
    const containVisualWheel = (event: WheelEvent) => {
      if (isInsideScrollLockedVisual(event.target)) event.preventDefault();
    };
    container.addEventListener("wheel", containVisualWheel, wheelOptions);
    return () => container.removeEventListener("wheel", containVisualWheel, wheelOptions);
  }, []);

  function pauseAutoScroll() {
    userScrolledRef.current = true;
    manualScrollLockUntilRef.current = Date.now() + 900;
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
  }

  function resumeAutoScroll() {
    userScrolledRef.current = false;
    manualScrollLockUntilRef.current = 0;
    setShowScrollButton(false);
    slideToBottom();
  }

  const showThinking = loading && messages.length > 0 && (latestMessage?.role === "user" || (latestMessage?.role === "assistant" && !latestMessage.content));
  const renderedMessages = useMemo(() => messages.map((message, index) => {
    const user = message.role === "user";
    if (user) {
      const attachedFiles: LocalAttachmentSummary[] = message.attachmentFiles ?? message.attachmentNames?.map((name) => ({ name, size: 0 })) ?? [];
      return (
        <article key={message.id} className="group mb-6 flex w-full justify-end">
          <div className="flex max-w-[84%] flex-col items-end gap-1.5">
            <div className={`rounded-2xl border border-border/40 bg-secondary px-4 py-3 text-left text-sm text-foreground ${attachedFiles.length > 0 ? "min-w-[min(21rem,84vw)]" : ""}`}>
              <MarkdownMessage content={message.content} />
              {message.toolLabels?.length ? (
                <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border/40 pt-2">
                  {message.toolLabels.map((label) => <span key={label} className="rounded-full bg-background/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">{label}</span>)}
                </div>
              ) : null}
              {attachedFiles.length ? (
                <div className="mt-3 space-y-2 border-t border-border/35 pt-2.5">
                  {attachedFiles.map((file) => (
                    <div key={file.name} className="flex items-center gap-2 rounded-2xl border border-border/35 bg-background/45 px-3 py-2">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                        <Icon className="h-4 w-4"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M9 15h6" /><path d="M9 18h4" /></Icon>
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold text-foreground">{file.name}</span>
                        <span className="block truncate text-[10px] text-muted-foreground">{attachmentMethodLabel(file.method)}{file.size ? ` · ${formatBytes(file.size)}` : ""}{file.truncated ? " · clipped" : ""}</span>
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="flex h-6 items-center gap-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <CopyActionButton value={message.content} label="Copy message" />
              <button type="button" onClick={() => onEditUserMessage(message, index)} className="inline-flex h-6 w-6 items-center justify-center rounded-md transition hover:bg-muted/50 hover:text-foreground" title="Edit message" aria-label="Edit message"><Icon className="h-3.5 w-3.5"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></Icon></button>
              <button type="button" onClick={() => onDeleteMessage(message, index)} className="inline-flex h-6 w-6 items-center justify-center rounded-md transition hover:bg-danger/10 hover:text-danger" title="Delete message" aria-label="Delete message"><Icon className="h-3.5 w-3.5"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="m19 6-1 14H6L5 6" /></Icon></button>
            </div>
          </div>
        </article>
      );
    }

    const parsed = parseThinkingContent(message.content);
    const answer = parsed.answer.trim();
    const isEmpty = !answer && !parsed.hasThinking;
    const copyContent = answer || parsed.thoughts.join("\n\n") || message.content;
    const previousUser = messages.slice(0, index).reverse().find((item) => item.role === "user");
    const durationLabel = formatThoughtDuration(previousUser?.createdAt, parsed.active ? undefined : message.createdAt);
    const pending = loading && latestMessage?.id === message.id;
    const thoughtNode = parsed.active
      ? <div className="luna-phase luna-phase-thinking"><ThinkingStatus label={thinkingMessage} className={parsed.thoughts.length > 0 ? "mb-3" : "mb-8"} /><LiveThoughtPreview thoughts={parsed.thoughts} /></div>
      : parsed.hasThinking
        ? <div className="luna-phase luna-phase-thought"><ThinkingBlock thoughts={parsed.thoughts} durationLabel={durationLabel} /></div>
        : null;
    return (
      <article key={message.id} className="group mb-8 flex w-full flex-col items-start gap-1.5 text-left">
        <div className="luna-assistant-message flex w-full max-w-none flex-col gap-3">
          {answer ? <div className="luna-final-answer luna-phase luna-phase-answer"><AssistantAnswer content={answer} afterAgent={thoughtNode} /></div> : thoughtNode}
        </div>
        {!isEmpty && (
          <div className="flex h-6 items-center gap-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <CopyActionButton value={copyContent} label="Copy message" />
            {!pending ? <button type="button" className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-muted/50 hover:text-foreground" aria-label="Regenerate message" title="Regenerate" onClick={() => onRegenerateMessage(message, index)}><Icon className="h-3.5 w-3.5"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" /><path d="M16 16h5v5" /></Icon></button> : null}
            <button type="button" className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-danger/10 hover:text-danger" aria-label="Delete message" title="Delete" onClick={() => onDeleteMessage(message, index)}><Icon className="h-3.5 w-3.5"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="m19 6-1 14H6L5 6" /></Icon></button>
          </div>
        )}
      </article>
    );
  }), [latestMessage?.id, loading, messages, onDeleteMessage, onEditUserMessage, onRegenerateMessage, thinkingMessage]);

  return (
    <div className="relative flex min-h-0 w-full flex-1">
      <div
        ref={scrollRef}
        onWheel={(event) => { if (isInsideScrollLockedVisual(event.target)) return; if (event.deltaY < 0) pauseAutoScroll(); }}
        className="scrollbar-thin flex min-h-0 w-full flex-1 flex-col overflow-y-auto px-3 overscroll-contain"
      >
        <div ref={contentRef} className="mx-auto flex w-full max-w-[736px] flex-col px-0 py-6">
          {renderedMessages}
          {showThinking ? <ThinkingStatus label={thinkingMessage} /> : null}
        </div>
      </div>
      {showScrollButton && messages.length > 0 ? (
        <button type="button" onClick={resumeAutoScroll} className="absolute bottom-4 left-1/2 z-20 inline-flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition hover:bg-primary/90" aria-label="Scroll to bottom">
          <Icon className="h-3.5 w-3.5"><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></Icon>
        </button>
      ) : null}
    </div>
  );
});

function Composer({
  prompt,
  setPrompt,
  loading,
  attachments,
  setAttachments,
  webSearchEnabled,
  setWebSearchEnabled,
  onSubmit,
  onStop
}: {
  prompt: string;
  setPrompt: (value: string) => void;
  loading: boolean;
  attachments: ChatAttachment[];
  setAttachments: Dispatch<SetStateAction<ChatAttachment[]>>;
  webSearchEnabled: boolean;
  setWebSearchEnabled: Dispatch<SetStateAction<boolean>>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onStop: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [uploadStatus, setUploadStatus] = useState("");
  const links = detectedWebUrls(prompt);
  const searchRequested = wantsWebSearch(prompt);
  const searchActive = searchRequested || webSearchEnabled;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [prompt]);

  async function handleFilesSelected(files: FileList | null) {
    setUploadError("");
    setUploadStatus("");
    try {
      const nextAttachments = readAttachments(files);
      if (nextAttachments.length === 0) return;
      setAttachments((current) => [...current, ...nextAttachments].slice(0, maxAttachedFiles));
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Could not read selected files");
    } finally {
      setUploadStatus("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = clipboardFiles(event);
    if (files.length > 0) {
      event.preventDefault();
      setAttachments((current) => [...current, ...attachmentPlaceholders(files)].slice(0, maxAttachedFiles));
      setUploadError("");
      return;
    }

    const text = event.clipboardData.getData("text/plain");
    if (text.length <= largePasteChars) return;
    event.preventDefault();
    const attachment = createPastedAttachment(text);
    setAttachments((current) => [...current, attachment].slice(0, maxAttachedFiles));
    setUploadError("");
  }

  function requestWebSearchIntent() {
    setWebSearchEnabled((current) => !current);
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
    });
  }

  return (
    <div className="relative w-full">
      <div className="relative w-full px-3 sm:px-4">
        <div className="w-full overflow-visible rounded-3xl border border-border bg-muted transition-colors">
          <form onSubmit={onSubmit} className="relative w-full">
            <div className="relative w-full bg-transparent">
              {attachments.length > 0 || uploadStatus ? (
                <div className="scrollbar-thin flex gap-2 overflow-x-auto px-2 pb-1.5 pt-2 text-left">
                  {attachments.map((file) => (
                    <div key={file.id} className="group inline-flex max-w-[230px] shrink-0 items-center gap-2 rounded-2xl border border-border/45 bg-muted/35 px-3 py-2 text-xs text-foreground">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-background/70 text-primary">
                        <Icon className="h-3.5 w-3.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M9 15h6" /><path d="M9 18h4" /></Icon>
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{file.name}</span>
                        <span className="block truncate text-[10px] text-muted-foreground">{attachmentMethodLabel(file.method)} · {formatBytes(file.size)}{file.truncated ? " · clipped" : ""}</span>
                      </span>
                      <button type="button" onClick={() => setAttachments((current) => current.filter((item) => item.id !== file.id))} className="shrink-0 rounded-full p-1 text-muted-foreground transition hover:bg-background hover:text-foreground" aria-label={`Remove ${file.name}`}>
                        <Icon className="h-3.5 w-3.5"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Icon>
                      </button>
                    </div>
                  ))}
                  {uploadStatus ? (
                    <div className="inline-flex shrink-0 items-center gap-2 rounded-2xl border border-primary/20 bg-primary/10 px-3 py-2 text-xs font-medium text-primary">
                      <DotAnimation small />
                      <span>{uploadStatus}</span>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="flex items-center px-4 pt-3">
                <textarea
                  ref={textareaRef}
                  className="max-h-[180px] min-h-[28px] w-full flex-1 resize-none overflow-y-auto border-0 bg-transparent px-0 py-0 text-sm leading-tight text-foreground shadow-none outline-none placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:ring-0"
                  placeholder={attachments.length > 0 ? "Ask about these files..." : "Ask Luna anything or paste a link..."}
                  rows={1}
                  value={prompt}
                  onChange={(event) => {
                    const nextPrompt = event.target.value;
                    setPrompt(nextPrompt);
                    setWebSearchEnabled(shouldAutoEnableWebSearch(nextPrompt));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  onPaste={handlePaste}
                />
              </div>
              {links.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 px-3 pb-2 text-left">
                  {links.map((url) => <span key={url} className="inline-flex max-w-full items-center gap-1.5 truncate rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary"><Icon className="h-3 w-3 shrink-0"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></Icon><span className="truncate">{urlHostLabel(url)}</span></span>)}
                </div>
              ) : null}

              <div className="mt-3 flex flex-wrap items-center gap-1 px-4 pb-3 text-foreground">
                <div className="flex items-center gap-1 -ml-2 text-muted-foreground">
                  <input ref={fileInputRef} type="file" className="hidden" multiple onChange={(event) => void handleFilesSelected(event.target.files)} />
                    <div className="relative">
                    <button className="inline-flex h-8 w-8 min-h-[36px] min-w-[36px] items-center justify-center rounded-full text-foreground transition-all hover:scale-105 hover:bg-transparent active:scale-95" type="button" aria-label="Add content" onClick={() => setAddOpen((value) => !value)}>
                      <Icon><path d="M5 12h14" /><path d="M12 5v14" /></Icon>
                    </button>
                    {addOpen ? (
                      <div className="luna-popover luna-popover-up absolute bottom-10 left-0 z-50 w-48 rounded-xl border border-border bg-background p-1 text-left shadow-panel">
                         <button type="button" onClick={() => { fileInputRef.current?.click(); setAddOpen(false); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-foreground hover:bg-muted/50"><Icon><path d="M21.44 11.05 12 20.49a6 6 0 0 1-8.49-8.49l9.44-9.44a4 4 0 0 1 5.66 5.66L9.17 17.66a2 2 0 0 1-2.83-2.83l8.49-8.49" /></Icon>Upload files</button>
                         <button type="button" onClick={() => { setAttachments([]); setAddOpen(false); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground"><Icon><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="m19 6-1 14H6L5 6" /></Icon>Clear files</button>
                       </div>
                     ) : null}
                   </div>
                  <div className="h-5 w-px bg-border" />
                   <button type="button" aria-label="Allow web search" aria-pressed={searchActive} title={searchActive ? "Web search allowed" : "Allow web search"} onClick={requestWebSearchIntent} className={`inline-flex h-8 w-8 min-h-[36px] min-w-[36px] items-center justify-center rounded-full transition-all hover:scale-105 hover:bg-transparent active:scale-95 ${searchActive ? "text-primary" : "text-foreground"}`}>
                    <Icon className="h-4 w-4"><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 0 20" /><path d="M12 2a15.3 15.3 0 0 0 0 20" /></Icon>
                  </button>
                </div>
                <div className="ml-auto flex items-center gap-2 -mr-2">
                  {loading ? (
                    <button className="flex h-9 w-9 items-center justify-center rounded-full border border-primary bg-primary text-primary-foreground transition-all duration-200 hover:bg-primary/90" type="button" onClick={onStop} aria-label="Stop generation">
                      <span className="h-3 w-3 rounded-sm bg-primary-foreground" />
                    </button>
                  ) : (
                    <button className={`flex h-9 w-9 items-center justify-center rounded-full border transition-all duration-200 ${prompt.trim() ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90" : "cursor-not-allowed border-border bg-muted/30 text-muted-foreground opacity-50"}`} type="submit" disabled={!prompt.trim()} aria-label="Send message">
                      <Icon><path d="m5 12 7-7 7 7" /><path d="M12 19V5" /></Icon>
                    </button>
                  )}
                </div>
              </div>
              {uploadError ? <p className="px-1 pb-2 pt-2 text-left text-xs text-red-300">{uploadError}</p> : null}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

function SetupChecklist({ hasModel }: { hasModel: boolean }) {
  if (hasModel) return null;

  return (
    <div className="mx-auto mb-5 mt-4 w-full max-w-[736px] text-left">
      <button type="button" onClick={() => openSettings("models")} className="w-full rounded-2xl border border-border/50 bg-card/80 p-4 text-left transition hover:border-primary/40 hover:bg-muted/30">
        <p className="text-sm font-semibold text-foreground">1. Add a model endpoint</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">Connect an OpenAI-compatible endpoint before sending production chat requests.</p>
      </button>
    </div>
  );
}

function DropOverlay({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div className="pointer-events-none absolute inset-3 z-50 flex items-center justify-center rounded-[2rem] border border-primary/35 bg-background/70 backdrop-blur-md">
      <div className="flex max-w-sm flex-col items-center rounded-3xl border border-border/60 bg-card/95 px-6 py-5 text-center shadow-panel">
        <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Icon className="h-6 w-6"><path d="M21.44 11.05 12 20.49a6 6 0 0 1-8.49-8.49l9.44-9.44a4 4 0 0 1 5.66 5.66L9.17 17.66a2 2 0 0 1-2.83-2.83l8.49-8.49" /></Icon>
        </span>
        <p className="text-sm font-semibold text-foreground">Drop files for Luna to read</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">PDFs, images, screenshots, and text files attach first. OCR runs as an agent step after send.</p>
      </div>
    </div>
  );
}

export function ChatPage() {
  const searchParams = useSearchParams();
  const conversationIdFromUrl = searchParams.get("conv");
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<LocalChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string | null>(() => getSelectedModel()?.model ?? null);
  const [headlineIndex, setHeadlineIndex] = useState(0);
  const [showMoreOpen, setShowMoreOpen] = useState(false);
  const [thinkingMessage, setThinkingMessage] = useState("Luna is thinking...");
  const [dragActive, setDragActive] = useState(false);
  const requestControllerRef = useRef<AbortController | null>(null);
  const submitPromptRef = useRef<SubmitPrompt | null>(null);
  const localConversationIdRef = useRef<string | null>(null);
  const messagesRef = useRef<LocalChatMessage[]>([]);
  const composerShellRef = useRef<HTMLDivElement | null>(null);
  const dragDepthRef = useRef(0);
  const [hasMessages, setHasMessages] = useState(false);
  const [codePanelWidth, setCodePanelWidth] = useState(0);
  const hasModel = Boolean(selectedModel);
  const chatLayoutStyle = { "--luna-code-panel-offset": codePanelWidth > 0 ? `${codePanelWidth + 28}px` : "0px" } as CSSProperties;

  const refreshSelectedModel = useCallback(() => {
    setSelectedModel(getSelectedModel()?.model ?? null);
  }, []);

  function getProviderConfig(): { base_url: string; api_key: string; model: string } | undefined {
    const settings = loadModelSettings();
    if (!settings.selected) return undefined;
    const endpoint = settings.endpoints.find((e) => e.id === settings.selected?.endpointId);
    if (!endpoint) return undefined;
    return {
      base_url: endpoint.baseUrl,
      api_key: endpoint.apiKey ?? "",
      model: settings.selected.model,
    };
  }

  async function prepareAttachmentsForRequest(files: ChatAttachment[], signal: AbortSignal, userMessageId: string): Promise<ChatAttachmentPayload[]> {
    if (files.length === 0) return [];

    const payloads: ChatAttachmentPayload[] = [];
    const attachmentFiles: LocalAttachmentSummary[] = files.map((file) => ({ name: file.name, size: file.size, method: file.method, truncated: file.truncated }));

    for (const file of files) {
      if (signal.aborted) return payloads;
      try {
        const extracted = file.file
          ? await readAttachmentFile(file.file, maxAttachmentChars)
          : { content: file.content, truncated: file.truncated, method: file.method ?? "text" as const, readable: file.content.trim().length > 0 };
        const method = extracted.method;
        const content = extracted.readable
          ? `[${attachmentMethodLabel(method)} extraction]\n${extracted.content}`
          : `[Attachment unreadable]\n${extracted.content}`;

        payloads.push({
          name: file.name,
          type: file.type,
          size: file.size,
          content,
          truncated: extracted.truncated,
        });
        attachmentFiles[payloads.length - 1] = { name: file.name, size: file.size, method, truncated: extracted.truncated };
        setMessages((current) => current.map((message) => message.id === userMessageId ? { ...message, attachmentFiles: [...attachmentFiles] } : message));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Could not read file";
        payloads.push({
          name: file.name,
          type: file.type,
          size: file.size,
          content: `[Attachment extraction error]\n${message}`,
          truncated: false,
        });
        attachmentFiles[payloads.length - 1] = { name: file.name, size: file.size, method: "text", truncated: false };
        setMessages((current) => current.map((message) => message.id === userMessageId ? { ...message, attachmentFiles: [...attachmentFiles] } : message));
      }
    }

    return payloads;
  }

  useEffect(() => {
    const interval = window.setInterval(() => setHeadlineIndex((current) => (current + 1) % headlinePrompts.length), 10000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    window.addEventListener(MODEL_SETTINGS_CHANGED, refreshSelectedModel);
    return () => window.removeEventListener(MODEL_SETTINGS_CHANGED, refreshSelectedModel);
  }, [refreshSelectedModel]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (!conversationIdFromUrl) return;
    queueMicrotask(() => setHasMessages(true));

    if (localConversationIdRef.current === conversationIdFromUrl) {
      queueMicrotask(() => setLoadingConversation(false));
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setLoadingConversation(true);
    });
    getConversationMessages({ conversationId: conversationIdFromUrl, signal: controller.signal })
      .then((result) => {
        if (cancelled) return;
        localConversationIdRef.current = conversationIdFromUrl;
        setMessages(result.data.length > 0 ? result.data : [{
          id: crypto.randomUUID(),
          conversationId: conversationIdFromUrl,
          role: "assistant",
          content: "This conversation does not have saved messages yet.",
          createdAt: new Date().toISOString(),
        }]);
      })
      .catch((err) => {
        if (cancelled) return;
        setMessages([{
          id: crypto.randomUUID(),
          conversationId: conversationIdFromUrl,
          role: "assistant",
          content: err instanceof Error ? `Error: ${err.message}` : "Error: failed to load conversation",
          createdAt: new Date().toISOString(),
        }]);
      })
      .finally(() => {
        if (!cancelled) setLoadingConversation(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [conversationIdFromUrl]);

  useEffect(() => {
    function onNewChat() {
      requestControllerRef.current?.abort();
      requestControllerRef.current = null;
      localConversationIdRef.current = null;
      if (window.location.pathname.startsWith("/chat")) window.history.pushState(null, "", "/chat");
      setPrompt("");
      setMessages([]);
      setAttachments([]);
      setWebSearchEnabled(false);
      setLoading(false);
      setLoadingConversation(false);
      setHasMessages(false);
    }
    window.addEventListener("newChatRequested", onNewChat);
    return () => window.removeEventListener("newChatRequested", onNewChat);
  }, []);

  useEffect(() => {
    return () => {
      requestControllerRef.current?.abort();
      requestControllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("luna:chat-state", { detail: { hasMessages: messages.length > 0 } }));
  }, [messages.length]);

  useEffect(() => {
    function onCodePanelLayout(event: Event) {
      const detail = (event as CustomEvent<{ open?: boolean; width?: number }>).detail;
      if (!detail?.open) {
        setCodePanelWidth(0);
        return;
      }
      const width = Number(detail.width ?? 0);
      setCodePanelWidth(Number.isFinite(width) && width > 0 ? width : 0);
    }

    window.addEventListener("luna:code-panel-layout", onCodePanelLayout);
    return () => window.removeEventListener("luna:code-panel-layout", onCodePanelLayout);
  }, []);

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    const files = Array.from(event.dataTransfer.files ?? []).slice(0, maxAttachedFiles).map((file, index) => normalizedFile(file, `dropped-file-${index + 1}`));
    if (files.length === 0) return;
    setAttachments((current) => [...current, ...attachmentPlaceholders(files)].slice(0, maxAttachedFiles));
  }

  async function submitPrompt(content: string, options: { appendUser?: boolean; conversationId?: string } = {}) {
    const value = content.trim();
    if (!value || loading) return;
    const provider = getProviderConfig();
    const appendUser = options.appendUser ?? true;

    if (!hasMessages) {
      setHasMessages(true);
    }

    setPrompt("");
    setWebSearchEnabled(false);
    setThinkingMessage("Luna is thinking...");
    const activeUrlConversationId = typeof window === "undefined" ? conversationIdFromUrl : new URLSearchParams(window.location.search).get("conv");
    const existingConversationId = options.conversationId ?? messages[0]?.conversationId ?? activeUrlConversationId ?? undefined;
    const conversationId = existingConversationId ?? crypto.randomUUID();
    localConversationIdRef.current = conversationId;
    const requestMessages = requestTurns(messagesRef.current, value);
    const attachmentsSnapshot = attachments;
    const userMessage: LocalChatMessage = {
      id: crypto.randomUUID(),
      conversationId,
      role: "user",
      content: value,
      createdAt: new Date().toISOString(),
      attachmentNames: attachmentsSnapshot.map((file) => file.name),
      attachmentFiles: attachmentsSnapshot.map((file) => ({ name: file.name, size: file.size, method: file.method, truncated: file.truncated })),
    };

    if (appendUser) {
      window.dispatchEvent(new Event(CHAT_SCROLL_BOTTOM_EVENT));
    }

    if (!provider) {
      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        conversationId,
        role: "assistant",
        content: "Add and select an OpenAI-compatible model endpoint in Settings before sending messages.",
        createdAt: new Date().toISOString(),
      };
      setMessages((current) => [...current, ...(appendUser ? [userMessage] : []), assistantMessage]);
      if (appendUser) window.setTimeout(() => window.dispatchEvent(new Event(CHAT_SCROLL_BOTTOM_EVENT)), 0);
      return;
    }

    showConversationUrl(conversationId, existingConversationId ? "replace" : "push");

    if (appendUser) {
      setMessages((current) => [...current, userMessage]);
      window.setTimeout(() => window.dispatchEvent(new Event(CHAT_SCROLL_BOTTOM_EVENT)), 0);
    }
    setAttachments([]);
    setLoading(true);

    requestControllerRef.current?.abort();
    const requestController = new AbortController();
    requestControllerRef.current = requestController;
    const placeholderId = crypto.randomUUID();

    const placeholderMessage: ChatMessage = {
      id: placeholderId,
      conversationId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      tokens: 0,
    };
    setMessages((current) => [...current, placeholderMessage]);

    const requestAttachments = await prepareAttachmentsForRequest(attachmentsSnapshot, requestController.signal, userMessage.id);
    if (requestController.signal.aborted || requestControllerRef.current !== requestController) return;

    try {
      const result = await sendChatMessage({
        content: value,
        conversationId,
        model: selectedModel ?? provider?.model ?? undefined,
        provider,
        messages: requestMessages,
        attachments: requestAttachments,
        signal: requestController.signal,
      });
      if (requestController.signal.aborted || requestControllerRef.current !== requestController) return;
      localConversationIdRef.current = result.conversationId;
      showConversationUrl(result.conversationId, "replace");
      setMessages((current) => current.map((message) => message.id === placeholderId ? result.message : message));
      window.dispatchEvent(new Event("luna:conversations-changed"));
    } catch (error) {
      if (requestController.signal.aborted || requestControllerRef.current !== requestController) return;
      const message = error instanceof Error ? error.message : "Network error";
      setMessages((current) => current.map((item) => item.id === placeholderId ? { ...item, content: `Error: ${message}` } : item));
    } finally {
      if (requestControllerRef.current === requestController) requestControllerRef.current = null;
      setLoading(false);
    }
  }

  useEffect(() => {
    submitPromptRef.current = submitPrompt;
  });

  function stopGeneration() {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    setLoading(false);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitPrompt(prompt);
  }

  const handleEditUserMessage = useCallback((message: LocalChatMessage, index: number) => {
    if (loading) return;
    setPrompt(message.content);
    setAttachments([]);
    setMessages((current) => current.slice(0, index));
    setHasMessages(index > 0);
  }, [loading]);

  const handleDeleteMessage = useCallback((_message: LocalChatMessage, index: number) => {
    if (loading) return;
    setMessages((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setHasMessages(messagesRef.current.length > 1);
  }, [loading]);

  const handleRegenerateMessage = useCallback((_message: LocalChatMessage, index: number) => {
    if (loading) return;
    const previousUser = messagesRef.current.slice(0, index).reverse().find((item) => item.role === "user");
    if (!previousUser) return;
    setMessages((current) => current.slice(0, index));
    window.setTimeout(() => {
      void submitPromptRef.current?.(previousUser.content, { appendUser: false, conversationId: previousUser.conversationId });
    }, 0);
  }, [loading]);

  if (!hasMessages) {
    return (
      <div style={chatLayoutStyle} className="luna-chat-code-layout relative flex w-full flex-1 flex-col items-center justify-center px-4 pb-20 text-center" onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
        <DropOverlay active={dragActive} />
        <div className="w-full max-w-[736px]">
          <div className="mb-3 flex justify-center">
            <Image src={logo} alt="Luna" className="luna-logo-image h-36 w-36 object-contain md:h-40 md:w-40" priority />
          </div>
          <div className="mb-5 flex animate-in cursor-default select-none items-center justify-center break-words text-center text-3xl font-bold leading-tight tracking-tight text-primary fade-in slide-in-from-bottom-3 duration-700 md:text-4xl lg:text-4xl">
            <div className="flex items-center overflow-hidden text-inherit">
              <div className="mr-2.5 mt-[0.36em] shrink-0 self-start"><DotAnimation /></div>
              <ScrambleText text={headlinePrompts[headlineIndex] ?? headlinePrompts[0]} />
            </div>
          </div>
          <Composer prompt={prompt} setPrompt={setPrompt} loading={loading} attachments={attachments} setAttachments={setAttachments} webSearchEnabled={webSearchEnabled} setWebSearchEnabled={setWebSearchEnabled} onSubmit={handleSubmit} onStop={stopGeneration} />
          <SetupChecklist hasModel={hasModel} />
          <div className="mx-auto mb-5 mt-5 w-full max-w-[736px] text-foreground">
            <div className="flex flex-wrap items-center justify-center gap-2">
              {suggestionButtons.map((item) => (
                <button key={item.label} type="button" onClick={() => void submitPrompt(item.prompt)} className="inline-flex items-center gap-2 rounded-full border border-border/50 bg-muted px-4 py-2 text-sm font-medium text-foreground transition-all duration-200 hover:border-border hover:bg-muted focus-visible:outline-none">
                  <SuggestionIcon name={item.icon} />
                  {item.label}
                </button>
              ))}
              <div className="relative">
                <button type="button" onClick={() => setShowMoreOpen((value) => !value)} className="inline-flex items-center gap-2 rounded-full border border-border/50 bg-muted px-4 py-2 text-sm font-medium text-foreground transition-all duration-200 hover:border-border hover:bg-muted focus-visible:outline-none">
                  Show More
                  <Icon className={`h-4 w-4 transition-transform duration-200 ${showMoreOpen ? "rotate-180" : ""}`}><path d="m6 9 6 6 6-6" /></Icon>
                </button>
                {showMoreOpen ? (
                  <div className="luna-popover luna-popover-down luna-popover-center absolute left-1/2 z-40 mt-2 max-h-80 w-48 overflow-y-auto rounded-2xl border border-border/40 bg-background p-2 text-left shadow-panel">
                    {moreSuggestions.map((item, index) => (
                      <div key={item.label}>
                        <button type="button" onClick={() => { setShowMoreOpen(false); void submitPrompt(item.prompt); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted/50">
                          <DotAnimation small />
                          <span>{item.label}</span>
                        </button>
                        {index < moreSuggestions.length - 1 ? <div className="mx-2 h-px bg-border/30" /> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={chatLayoutStyle} className="luna-chat-code-layout relative flex min-h-0 w-full flex-1 flex-col overflow-hidden text-center" onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
      <CodePanelHost />
      <DropOverlay active={dragActive} />
      <MessageThread messages={messages} loading={loading || loadingConversation} thinkingMessage={loadingConversation ? "loading conversation..." : thinkingMessage} onEditUserMessage={handleEditUserMessage} onDeleteMessage={handleDeleteMessage} onRegenerateMessage={handleRegenerateMessage} />
      <div ref={composerShellRef} className="luna-composer-dock-in relative flex-shrink-0 px-2 pb-2">
        <div className="mx-auto w-full max-w-[736px] bg-none relative z-0">
          <Composer prompt={prompt} setPrompt={setPrompt} loading={loading} attachments={attachments} setAttachments={setAttachments} webSearchEnabled={webSearchEnabled} setWebSearchEnabled={setWebSearchEnabled} onSubmit={handleSubmit} onStop={stopGeneration} />
          <p className="px-4 pb-2 pt-2 text-center text-[10px] text-muted-foreground/60">Luna can make mistakes</p>
        </div>
      </div>
    </div>
  );
}
