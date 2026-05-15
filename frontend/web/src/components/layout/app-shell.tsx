"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState, useCallback, type MouseEvent, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import logo from "@/assets/logo.png";
import noMail from "@/assets/no-mail.png";
import placeholder from "@/assets/placeholder.png";
import { ChatMatrix } from "@/components/ui/chat-matrix";
import {
  loadModelSettings,
  MODEL_SETTINGS_CHANGED,
  deleteEndpoint,
  saveModelSettings,
  selectModel,
  upsertEndpoint,
  type ModelSettings,
  type OpenAiEndpoint
} from "@/services/model-settings";
import { deleteConversation, fetchModels, getConversations, recordLog, updateConversation } from "@/services/api";
import { useWorkspaceId } from "@/hooks/use-workspace-id";
import { ModelIcon } from "@/components/model-icon";
import { WoozlitDeleteDialog } from "@/components/ui/woozlit-delete-dialog";
import type { Conversation } from "@/types";
import {
  APPEARANCE_SETTINGS_CHANGED,
  applyAppearanceSettings,
  defaultAppearanceSettings,
  fontOptions,
  getThemeById,
  loadAppearanceSettings,
  radiusOptions,
  saveAppearanceSettings,
  themeFilters,
  themes,
  type AppearanceSettings as AppearancePreferences,
  type ThemeDefinition,
  type ThemeFilter
} from "@/services/theme-settings";

const settingsItems = [
  { id: "models", label: "Models" },
  { id: "appearance", label: "Appearance" },
  { id: "system", label: "System" },
  { id: "data", label: "Data Storage" },
  { id: "hotkeys", label: "Hotkeys" },
  { id: "about", label: "About" }
] as const;

type SettingsTab = (typeof settingsItems)[number]["id"];
type OpenSettingsDetail = { tab?: SettingsTab };
type ConversationsChangedDetail = { conversation?: Partial<Conversation> & { id: string } };

function mergeConversation(current: Conversation[], incoming: Partial<Conversation> & { id: string }, workspaceId: string) {
  const now = new Date().toISOString();
  const conversation: Conversation = {
    workspaceId,
    title: "Untitled conversation",
    model: "unknown-model",
    createdAt: now,
    updatedAt: now,
    messageCount: 1,
    pinned: false,
    ...incoming
  };
  const existing = current.find((chat) => chat.id === conversation.id);
  const merged = existing ? { ...existing, ...conversation } : conversation;
  return [merged, ...current.filter((chat) => chat.id !== conversation.id)]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function Icon({ children, className = "h-4 w-4" }: { children: ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

function DotMatrix({ small = false }: { small?: boolean }) {
  return (
    <div className={`luna-dot-grid luna-dot-matrix ${small ? "h-4 w-4" : "h-[20.5px] w-[20.5px]"} text-primary`} aria-hidden="true">
      <ChatMatrix size={5} dotSize={small ? 2 : 2.5} gap={2} staticPattern={false} />
    </div>
  );
}

function recordUiEvent(action: string, metadata: Record<string, unknown> = {}) {
  void recordLog({ service: "web-client", action, metadata }).catch(() => undefined);
}

function selectedModelLabel(settings: ModelSettings) {
  if (!settings.selected) return "Select model";
  const endpoint = settings.endpoints.find((item) => item.id === settings.selected?.endpointId);
  return endpoint ? settings.selected.model : "Select model";
}

function SettingsItemIcon({ id }: { id: SettingsTab }) {
  if (id === "appearance") return <Icon className="h-4 w-4"><path d="M12 3a9 9 0 0 0 0 18h1.5a2.5 2.5 0 0 0 0-5H12a4 4 0 0 1 0-8h1.5a2.5 2.5 0 0 0 0-5H12Z" /><circle cx="7.5" cy="10.5" r=".5" /><circle cx="9.5" cy="7.5" r=".5" /><circle cx="14.5" cy="7.5" r=".5" /></Icon>;
  if (id === "models") return <Icon className="h-4 w-4"><path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z" /><path d="m4 7.5 8 4.5 8-4.5" /><path d="M12 12v9" /></Icon>;
  if (id === "system") return <Icon className="h-4 w-4"><path d="M20 7h-9" /><path d="M14 17H5" /><circle cx="17" cy="17" r="3" /><circle cx="7" cy="7" r="3" /></Icon>;
  if (id === "data") return <Icon className="h-4 w-4"><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></Icon>;
  if (id === "hotkeys") return <Icon className="h-4 w-4"><path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" /><path d="M7 9h.01" /><path d="M10 9h.01" /><path d="M13 9h.01" /><path d="M16 9h.01" /><path d="M8 13h8" /></Icon>;
  return <Icon className="h-4 w-4"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></Icon>;
}

function UserPlaceholder({ className = "h-12 w-12" }: { className?: string }) {
  return (
    <Image src={placeholder} alt="" className={`luna-placeholder-image shrink-0 object-contain ${className}`} priority />
  );
}

function requestNewChat() {
  recordUiEvent("ui.chat.new");
  window.dispatchEvent(new CustomEvent("newChatRequested"));
  if (!window.location.pathname.startsWith("/chat")) window.location.assign("/chat");
}

function sidebarDateGroup(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Earlier";

  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const daysAgo = Math.round((todayStart - dateStart) / 86_400_000);

  if (daysAgo === 0) return "Today";
  if (daysAgo === 1) return "Yesterday";
  if (daysAgo < 7) return "This Week";

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric"
  });
}

function HeaderAction({ href, active, label, children }: { href: Route; active: boolean; label: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`luna-header-action group inline-flex h-9 items-center gap-2 overflow-hidden rounded-2xl border px-3 text-xs font-semibold transition-all duration-200 ${active ? "border-primary/40 bg-primary text-primary-foreground shadow-[0_12px_34px_hsl(var(--primary)/0.18)]" : "border-border/45 bg-card/75 text-muted-foreground hover:-translate-y-0.5 hover:border-primary/30 hover:bg-muted/55 hover:text-foreground"}`}
    >
      <span className={`flex h-5 w-5 items-center justify-center rounded-lg transition-colors ${active ? "bg-primary-foreground/15" : "bg-muted/50 text-primary group-hover:bg-primary/10"}`}>
        {children}
      </span>
      <span className="hidden sm:inline">{label}</span>
    </Link>
  );
}

function Sidebar({ open, onClose, onSettings, workspaceId }: { open: boolean; onClose: () => void; onSettings: () => void; workspaceId: string }) {
  const [chatsExpanded, setChatsExpanded] = useState(true);
  const [chats, setChats] = useState<Conversation[]>([]);
  const [pendingDeleteChat, setPendingDeleteChat] = useState<Conversation | null>(null);
  const [deletingChatId, setDeletingChatId] = useState<string | null>(null);
  const [renameChat, setRenameChat] = useState<Conversation | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const deleteDialogRef = useRef<HTMLDivElement>(null);
  const refreshTimersRef = useRef<number[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    getConversations({ page: 1, pageSize: 20, signal: controller.signal })
      .then((result) => { if (!cancelled) setChats(result.data); })
      .catch(() => {});
    return () => { cancelled = true; controller.abort(); };
  }, []);

  const refreshChats = useCallback((options: { retry?: boolean } = {}) => {
    function schedule(attempt: number) {
      const timer = window.setTimeout(() => {
        refreshTimersRef.current = refreshTimersRef.current.filter((item) => item !== timer);
        run(attempt);
      }, Math.min(5_000, 450 + attempt * 750));
      refreshTimersRef.current.push(timer);
    }

    function run(attempt: number) {
      getConversations({ page: 1, pageSize: 20 })
        .then((result) => {
          setChats(result.data);
          const activeId = new URLSearchParams(window.location.search).get("conv");
          if (options.retry && activeId && !result.data.some((chat) => chat.id === activeId) && attempt < 10) schedule(attempt + 1);
        })
        .catch(() => {
          if (options.retry && attempt < 10) schedule(attempt + 1);
        });
    }

    run(0);
  }, []);

  useEffect(() => {
    function onConversationsChanged(event: Event) {
      const conversation = (event as CustomEvent<ConversationsChangedDetail>).detail?.conversation;
      if (conversation) setChats((current) => mergeConversation(current, conversation, workspaceId));
      refreshChats({ retry: true });
    }

    window.addEventListener("luna:conversations-changed", onConversationsChanged);
    return () => window.removeEventListener("luna:conversations-changed", onConversationsChanged);
  }, [refreshChats, workspaceId]);

  useEffect(() => {
    return () => {
      for (const timer of refreshTimersRef.current) window.clearTimeout(timer);
      refreshTimersRef.current = [];
    };
  }, []);

  const chatGroups = useMemo(() => {
    const groups: Array<{ label: string; chats: Conversation[] }> = [];
    for (const chat of chats.filter((item) => !item.pinned)) {
      const label = sidebarDateGroup(chat.updatedAt);
      const group = groups.find((item) => item.label === label);
      if (group) group.chats.push(chat);
      else groups.push({ label, chats: [chat] });
    }
    return groups;
  }, [chats]);
  const pinnedChats = useMemo(() => chats.filter((chat) => chat.pinned), [chats]);
  const activeConversationId = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("conv");

  useEffect(() => {
    if (!pendingDeleteChat) return;

    deleteDialogRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !deletingChatId) setPendingDeleteChat(null);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deletingChatId, pendingDeleteChat]);

  const handleDeleteChat = useCallback((event: MouseEvent<HTMLButtonElement>, chat: Conversation) => {
    event.preventDefault();
    event.stopPropagation();
    if (deletingChatId) return;
    setPendingDeleteChat(chat);
  }, [deletingChatId]);

  const startRenameChat = useCallback((event: MouseEvent<HTMLButtonElement>, chat: Conversation) => {
    event.preventDefault();
    event.stopPropagation();
    setRenameChat(chat);
    setRenameTitle(chat.title || "Untitled conversation");
  }, []);

  const togglePinChat = useCallback(async (event: MouseEvent<HTMLButtonElement>, chat: Conversation) => {
    event.preventDefault();
    event.stopPropagation();
    const nextPinned = !chat.pinned;
    setChats((current) => current.map((item) => item.id === chat.id ? { ...item, pinned: nextPinned } : item));
    try {
      const updated = await updateConversation({ conversationId: chat.id, pinned: nextPinned });
      setChats((current) => current.map((item) => item.id === updated.id ? updated : item));
      window.dispatchEvent(new Event("luna:conversations-changed"));
    } catch {
      setChats((current) => current.map((item) => item.id === chat.id ? { ...item, pinned: chat.pinned } : item));
    }
  }, []);

  const confirmRenameChat = useCallback(async () => {
    const title = renameTitle.trim();
    if (!renameChat || !title) return;
    const previous = renameChat;
    setChats((current) => current.map((item) => item.id === previous.id ? { ...item, title } : item));
    setRenameChat(null);
    try {
      const updated = await updateConversation({ conversationId: previous.id, title });
      setChats((current) => current.map((item) => item.id === updated.id ? updated : item));
      window.dispatchEvent(new Event("luna:conversations-changed"));
    } catch {
      setChats((current) => current.map((item) => item.id === previous.id ? previous : item));
    }
  }, [renameChat, renameTitle]);

  const confirmDeleteChat = useCallback(async () => {
    if (!pendingDeleteChat || deletingChatId) return;
    const conversationId = pendingDeleteChat.id;

    setDeletingChatId(conversationId);
    try {
      await deleteConversation({ conversationId });
      setChats((current) => current.filter((chat) => chat.id !== conversationId));
      setPendingDeleteChat(null);
      window.dispatchEvent(new Event("luna:conversations-changed"));
      if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("conv") === conversationId) {
        window.history.pushState(null, "", "/chat");
        window.dispatchEvent(new Event("newChatRequested"));
      }
    } catch {
      // Keep the compact sidebar quiet; the chat list refreshes on the next event.
    } finally {
      setDeletingChatId(null);
    }
  }, [deletingChatId, pendingDeleteChat]);

  return (
    <>
      {open ? <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={onClose} /> : null}
      <aside
        aria-hidden={!open}
        data-state={open ? "open" : "closed"}
        className={`modern-sidebar fixed inset-y-0 left-0 z-50 flex h-[100dvh] flex-col bg-card font-sans transition-all duration-200 ease-out md:relative md:translate-x-0 ${open ? "w-[280px] translate-x-0 md:w-60" : "-translate-x-full md:w-0 md:opacity-0 md:pointer-events-none"}`}
      >
        <div className="flex items-center justify-between px-4 py-3">
          <Link className="sidebar-brand group -ml-1 flex min-w-0 items-center gap-2 rounded-xl px-1 py-0.5" href="/chat" aria-label="Luna home">
            <span className="sidebar-brand-mark flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-xl">
              <Image src={logo} alt="" className="luna-logo-image h-7 w-7 object-contain transition-transform duration-300 ease-out group-hover:scale-105" priority />
            </span>
            <span className="sidebar-brand-name truncate bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-lg font-extrabold tracking-tighter text-transparent">Luna</span>
          </Link>
        </div>

        <div className="flex flex-col gap-1 px-1 py-1.5">
          <button type="button" onClick={requestNewChat} className="sidebar-nav-item inline-flex h-8 w-full items-center justify-start gap-2 whitespace-nowrap rounded-xl px-3 py-1.5 text-xs font-normal text-muted-foreground outline-none transition-colors hover:bg-muted/50 hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <Icon className="h-3.5 w-3.5"><path d="M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5" /><path d="M18.586 3.586a2 2 0 1 1 2.828 2.828L11.828 16H9v-2.828l9.586-9.586z" /></Icon>
            <span>New Chat</span>
          </button>
        </div>

        <div className="relative min-h-0 flex-1 overflow-y-auto px-1.5 scrollbar-thin">
          <div className="flex flex-col gap-2 pb-4 pt-1">
            <button type="button" onClick={() => setChatsExpanded((value) => !value)} className="group flex w-full items-center gap-1 px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground/40 transition-colors hover:text-muted-foreground/60">
              <span>Chats</span>
              <Icon className={`h-2.5 w-2.5 transition-transform ${chatsExpanded ? "rotate-180" : ""}`}><path d="m6 9 6 6 6-6" /></Icon>
            </button>
            {pinnedChats.length > 0 ? (
              <div>
                <div className="px-2 pb-1 pt-1"><span className="text-[10px] font-medium text-muted-foreground/40">Pinned</span></div>
                {pinnedChats.map((chat) => (
                  <div key={chat.id} className="group relative" data-state={activeConversationId === chat.id ? "open" : "closed"}>
                    <Link href={`/chat?conv=${chat.id}`} className={`flex items-center gap-2 rounded-xl px-2 py-1.5 transition-colors ${activeConversationId === chat.id ? "bg-muted/60" : "hover:bg-muted/50"}`}>
                      <ModelIcon modelId={chat.model} className="h-3.5 w-3.5 shrink-0 text-primary" />
                      <span className="min-w-0 flex-1 truncate text-xs font-normal text-muted-foreground transition-colors group-hover:text-foreground">{chat.title}</span>
                    </Link>
                    <div className="absolute right-1 top-1/2 flex -translate-y-1/2 gap-0 opacity-0 transition-opacity group-hover:opacity-100">
                      <button type="button" onClick={(event) => togglePinChat(event, chat)} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-yellow-400 transition-colors hover:bg-muted/50" title="Unpin chat" aria-label={`Unpin ${chat.title}`}><Icon className="h-3 w-3"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01Z" /></Icon></button>
                      <button type="button" onClick={(event) => startRenameChat(event, chat)} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground" title="Rename chat" aria-label={`Rename ${chat.title}`}><Icon className="h-3 w-3"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></Icon></button>
                      <button type="button" onClick={(event) => handleDeleteChat(event, chat)} disabled={deletingChatId === chat.id} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40" title="Delete chat" aria-label={`Delete ${chat.title}`}><Icon className="h-3 w-3"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></Icon></button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            {chatsExpanded ? (
              chats.length === 0 ? (
                <div className="mt-10 flex flex-col items-center justify-center gap-4 text-center text-sm text-muted-foreground">
                  <Image src={noMail} alt="No chats yet" className="h-12 w-12 object-contain opacity-80" priority={false} />
                  <p className="text-sm font-medium text-muted-foreground">No chats yet</p>
                </div>
              ) : chatGroups.length === 0 ? null : (
                <div>
                  {chatGroups.map((group) => (
                    <div key={group.label}>
                      <div className="px-2 pb-0.5 pt-1">
                        <span className="text-[11px] font-medium text-muted-foreground/30"># {group.label}</span>
                      </div>
                      {group.chats.map((chat) => (
                        <div key={chat.id} className="group relative" data-state="closed">
                          <Link href={`/chat?conv=${chat.id}`} className={`flex items-center gap-2 rounded-xl px-2 py-1.5 transition-colors ${activeConversationId === chat.id ? "bg-muted/60" : "hover:bg-muted/50"}`}>
                            <ModelIcon modelId={chat.model} className={`h-3.5 w-3.5 shrink-0 ${activeConversationId === chat.id ? "text-primary" : "text-muted-foreground/60 group-hover:text-primary"}`} />
                            <span className={`min-w-0 flex-1 truncate text-xs font-normal transition-colors ${activeConversationId === chat.id ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"}`}>{chat.title}</span>
                          </Link>
                          <div className="absolute right-1 top-1/2 flex -translate-y-1/2 gap-0 opacity-0 transition-opacity group-hover:opacity-100">
                            <button type="button" onClick={(event) => togglePinChat(event, chat)} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-yellow-400" title="Pin chat" aria-label={`Pin ${chat.title}`}><Icon className="h-3 w-3"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01Z" /></Icon></button>
                            <button type="button" onClick={(event) => startRenameChat(event, chat)} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground" title="Rename chat" aria-label={`Rename ${chat.title}`}><Icon className="h-3 w-3"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></Icon></button>
                            <button type="button" onClick={(event) => handleDeleteChat(event, chat)} disabled={deletingChatId === chat.id} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40" title="Delete chat" aria-label={`Delete ${chat.title}`}><Icon className="h-3 w-3"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></Icon></button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )
            ) : null}
          </div>
        </div>

        <div className="px-2 pb-3">
          <button type="button" onClick={onSettings} className="flex w-full items-center gap-2 rounded-lg p-1.5 text-left transition-all hover:bg-muted/35 hover:opacity-90">
            <UserPlaceholder className="h-9 w-9" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-normal text-muted-foreground">Local workspace</div>
              <div className="truncate text-xs text-muted-foreground/80"><span>{workspaceId.slice(0, 8)}</span></div>
            </div>
          </button>
        </div>
      </aside>
      <WoozlitDeleteDialog ref={deleteDialogRef} open={Boolean(pendingDeleteChat)} deleting={Boolean(deletingChatId)} onClose={() => setPendingDeleteChat(null)} onConfirm={() => void confirmDeleteChat()} />
      {renameChat ? (
        <div className="fixed inset-0 z-[10000] bg-black/50" onMouseDown={() => setRenameChat(null)}>
          <form
            className="fixed left-1/2 top-1/2 z-[10001] grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-2xl border border-border bg-background p-6 shadow-panel sm:max-w-sm"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={(event) => { event.preventDefault(); void confirmRenameChat(); }}
          >
            <div className="flex flex-col gap-2 text-center sm:text-left">
              <h2 className="text-lg font-semibold text-foreground">Rename Chat</h2>
              <p className="text-sm text-muted-foreground">Enter a new name for this chat.</p>
            </div>
            <input autoFocus value={renameTitle} onChange={(event) => setRenameTitle(event.target.value)} className="h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/30" placeholder="Chat name..." />
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" onClick={() => setRenameChat(null)} className="inline-flex h-9 items-center justify-center rounded-md border border-border bg-background px-4 py-2 text-sm font-medium transition hover:bg-muted">Cancel</button>
              <button type="submit" disabled={!renameTitle.trim()} className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50">Rename</button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}

function ModelDialog({ open, settings, onClose, onSelect, onOpenSettings }: { open: boolean; settings: ModelSettings; onClose: () => void; onSelect: () => void; onOpenSettings: () => void }) {
  const [query, setQuery] = useState("");
  const models = useMemo(() => settings.endpoints.flatMap((endpoint) => endpoint.models.map((model) => ({ endpoint, model }))), [settings.endpoints]);
  const filtered = models.filter((item) => `${item.endpoint.name} ${item.model}`.toLowerCase().includes(query.toLowerCase()));

  const grouped = useMemo(() => {
    const groups: Record<string, typeof filtered> = {};
    for (const item of filtered) {
      const key = item.endpoint.name;
      if (!groups[key]) groups[key] = [];
      groups[key].push(item);
    }
    return groups;
  }, [filtered]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-end justify-center bg-black/55 p-0 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={onClose}>
      <div className="flex h-[82dvh] w-full flex-col overflow-hidden rounded-t-3xl border-x border-t border-border/50 bg-background shadow-panel sm:h-auto sm:max-h-[560px] sm:max-w-2xl sm:rounded-3xl sm:border" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex h-9 items-center gap-2 border-b border-border/40 px-3">
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></Icon>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models..." className="flex h-full w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground" />
        </div>
        <div className="scrollbar-thin overflow-y-auto h-[calc(100dvh-60px)] sm:max-h-[400px]">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
              <DotMatrix />
              <p className="text-sm font-medium text-foreground">No models configured</p>
              <p className="max-w-sm text-xs leading-5 text-muted-foreground">Add your OpenAI-compatible API endpoint and model IDs in settings, then choose one here.</p>
              <button type="button" onClick={onOpenSettings} className="h-9 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">Open Models settings</button>
            </div>
          ) : (
            <div className="p-1">
              {Object.entries(grouped).map(([provider, items]) => (
                <div key={provider} className="overflow-hidden p-1">
                  <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{provider}</div>
                  <div role="group" aria-labelledby={provider}>
                    {items.map(({ endpoint, model }) => {
                      const active = settings.selected?.endpointId === endpoint.id && settings.selected.model === model;
                      return (
                        <button key={`${endpoint.id}:${model}`} type="button" onClick={() => { selectModel({ endpointId: endpoint.id, model }); recordUiEvent("ui.model.selected", { provider: endpoint.name, model }); onSelect(); onClose(); }} className={`group relative flex w-full cursor-default items-center justify-between rounded-sm py-2 px-2 text-sm outline-none select-none transition-all duration-150 ${active ? "scale-[0.98] bg-muted text-foreground" : "hover:scale-[1.01] hover:bg-muted/50 hover:text-foreground hover:shadow-[0_0_12px_hsl(var(--primary)/0.15)]"}`}>
                          <div className="flex items-center gap-2">
                            <ModelIcon modelId={model} className={`size-4 shrink-0 transition-transform duration-150 group-hover:scale-110 ${active ? "text-primary" : "text-muted-foreground group-hover:text-primary"}`} />
                            <span className="flex-1 truncate text-left">{model}</span>
                          </div>
                          {active ? <Icon className="ml-auto size-4 text-primary"><path d="M20 6 9 17l-5-5" /></Icon> : <span className="ml-auto size-4 rounded-full bg-primary/20 opacity-0 transition-opacity duration-150 group-hover:opacity-100" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <button type="button" onClick={onClose} className="absolute right-3 top-3 rounded-sm text-muted-foreground opacity-70 transition-opacity hover:text-foreground hover:opacity-100" aria-label="Close">
          <Icon className="size-4"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Icon>
        </button>
      </div>
    </div>
  );
}

function SettingsDialog({ open, initialTab, settings, workspaceId, onClose, onSettingsChanged }: { open: boolean; initialTab: SettingsTab; settings: ModelSettings; workspaceId: string; onClose: () => void; onSettingsChanged: () => void }) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [menuVisible, setMenuVisible] = useState(true);

  if (!open) return null;

  return (
    <div className="luna-modal-overlay fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4 animate-in fade-in-0 duration-200" onMouseDown={onClose}>
      <div className="luna-modal-panel h-[100dvh] w-full max-w-full border-none bg-transparent p-0 text-foreground shadow-none sm:h-[75vh] sm:max-h-[680px] sm:max-w-[900px] sm:rounded-3xl animate-in zoom-in-95 fade-in-0 duration-200" onMouseDown={(event) => event.stopPropagation()}>
        <div className="luna-settings-panel relative flex h-full w-full flex-col overflow-hidden bg-background sm:rounded-3xl sm:border sm:border-border/40 lg:flex-row">
          <button type="button" onClick={onClose} className="absolute right-4 top-4 z-50 inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted/50 hover:text-foreground focus-visible:outline-none" aria-label="Close settings">
            <Icon><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Icon>
          </button>
          <aside className={`flex w-full flex-col bg-background pt-10 px-3 pb-3 overflow-y-auto lg:w-[240px] lg:border-r lg:border-border/40 lg:flex lg:bg-muted/10 lg:p-3 ${!menuVisible ? "hidden" : ""}`}>
            <div className="mb-3 mt-1 px-2">
              <div className="flex items-center gap-3">
                <UserPlaceholder className="h-10 w-10" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-bold text-foreground">Local workspace</p>
                  <p className="truncate text-xs text-muted-foreground">{workspaceId}</p>
                </div>
              </div>
            </div>
            <nav className="flex-1 overflow-y-auto">
              <div className="space-y-0">
                {settingsItems.map((item) => (
                  <button key={item.id} type="button" onClick={() => { setActiveTab(item.id); setMenuVisible(false); }} className={`group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm font-medium transition-all ${activeTab === item.id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`}>
                    <span className={`flex h-4 w-4 shrink-0 items-center justify-center transition-colors ${activeTab === item.id ? "text-primary" : "text-muted-foreground group-hover:text-foreground"}`}><SettingsItemIcon id={item.id} /></span>
                    <span className="flex-1 text-sm">{item.label}</span>
                  </button>
                ))}
              </div>
            </nav>
          </aside>
          <section className={`flex-1 overflow-hidden bg-background ${menuVisible ? "hidden lg:flex lg:flex-col" : "flex flex-col"}`}>
            <button type="button" onClick={() => setMenuVisible(true)} className="flex items-center gap-2 px-6 py-4 text-sm font-medium text-muted-foreground hover:text-foreground lg:hidden">
              <Icon className="h-4 w-4"><path d="m15 18-6-6 6-6" /></Icon>
              <span>Back to menu</span>
            </button>
            <div className="h-full overflow-y-auto p-5 lg:p-6">
              <SettingsPanel tab={activeTab} settings={settings} onSettingsChanged={onSettingsChanged} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <header>
      <h1 className="text-lg font-bold text-foreground">{title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </header>
  );
}

function colorValue(value: string) {
  return `hsl(${value})`;
}

function ThemePreviewCard({ theme, selected, onSelect }: { theme: ThemeDefinition; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`group relative w-32 shrink-0 overflow-hidden rounded-xl border text-left transition-all ${selected ? "opacity-100 shadow-[0_12px_36px_hsl(var(--primary)/0.16)]" : "opacity-90 hover:opacity-100"}`}
      style={{ borderColor: selected ? colorValue(theme.colors.primary) : colorValue(theme.colors.border) }}
      aria-pressed={selected}
    >
      <div className="flex h-16 p-2" style={{ background: colorValue(theme.colors.background) }}>
        <div className="mr-1.5 w-1/4 rounded-sm" style={{ background: colorValue(theme.colors.muted) }} />
        <div className="flex flex-1 flex-col gap-1">
          <div className="h-2 w-4/5 rounded-sm" style={{ background: colorValue(theme.colors.primary) }} />
          <div className="h-1.5 w-3/5 rounded-sm" style={{ background: colorValue(theme.colors.mutedForeground) }} />
          <div className="h-1.5 w-2/3 rounded-sm" style={{ background: colorValue(theme.colors.border) }} />
        </div>
      </div>
      <div className={`flex items-center justify-between px-2 py-1.5 ${selected ? "bg-primary/10 text-primary" : "bg-muted/20 text-foreground"}`}>
        <span className="truncate text-xs font-medium">{theme.name}</span>
        {selected ? <Icon className="h-3 w-3 shrink-0"><path d="m20 6-11 11-5-5" /></Icon> : null}
      </div>
    </button>
  );
}

function LayoutPreviewButton({ value, active, onSelect }: { value: AppearancePreferences["layout"]; active: boolean; onSelect: () => void }) {
  return (
    <button type="button" onClick={onSelect} className={`relative w-32 shrink-0 overflow-hidden rounded-xl border border-border/50 text-left transition-all ${active ? "opacity-100" : "opacity-75 hover:opacity-100"}`} aria-pressed={active}>
      <div className="flex h-16 gap-1 bg-zinc-900 p-2">
        <div className={`${value === "classic" ? "rounded-sm" : "rounded"} w-1/4 bg-zinc-800`} />
        <div className={`flex flex-1 flex-col gap-1 bg-zinc-800 p-1.5 ${value === "classic" ? "rounded-sm" : "rounded-xl"}`}>
          <div className={`${value === "classic" ? "rounded-sm" : "rounded-lg"} flex-1 bg-zinc-700`} />
          <div className="h-1.5 w-2/3 rounded-full bg-zinc-600" />
        </div>
      </div>
      <div className={`flex items-center justify-between px-2 py-1.5 ${active ? "bg-primary/20 text-foreground" : "bg-muted/20 text-muted-foreground"}`}>
        <span className="text-xs font-medium">{value === "classic" ? "Classic" : "Modern"}</span>
        {active ? <Icon className="h-3 w-3 text-primary"><path d="m20 6-11 11-5-5" /></Icon> : null}
      </div>
    </button>
  );
}

function AppearanceSelect<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, { label: string }]>; onChange: (value: T) => void }) {
  const [open, setOpen] = useState(false);
  const selected = options.find(([optionValue]) => optionValue === value)?.[1].label ?? "Select";

  return (
    <div className="relative">
      {open ? <button type="button" className="fixed inset-0 z-[9998] cursor-default" tabIndex={-1} onClick={() => setOpen(false)} aria-label="Close select" /> : null}
      {open ? (
        <div className="absolute bottom-full left-0 z-[9999] mb-1 max-h-72 w-full overflow-y-auto rounded-xl border border-border/50 bg-background p-1 shadow-panel">
          {options.map(([optionValue, option]) => {
            const active = optionValue === value;
            return (
              <button key={optionValue} type="button" onClick={() => { onChange(optionValue); setOpen(false); }} className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm font-semibold transition ${active ? "text-foreground" : "text-foreground hover:bg-muted/50"}`}>
                <span>{option.label}</span>
                {active ? <Icon className="h-4 w-4 text-muted-foreground"><path d="m20 6-11 11-5-5" /></Icon> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <button type="button" onClick={() => setOpen((current) => !current)} className="flex h-9 w-full items-center justify-between rounded-xl border border-border/50 bg-muted/30 px-3 text-left text-sm font-semibold text-foreground outline-none transition hover:bg-muted/45 focus-visible:border-primary/50">
        <span className="truncate">{selected}</span>
        <Icon className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}><path d="m6 9 6 6 6-6" /></Icon>
      </button>
    </div>
  );
}

function AppearanceSettings() {
  const [appearance, setAppearance] = useState<AppearancePreferences>(defaultAppearanceSettings);
  const [activeFilter, setActiveFilter] = useState<ThemeFilter>("All");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query).trim().toLowerCase();
  const themeRowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    queueMicrotask(() => setAppearance(loadAppearanceSettings()));
  }, []);

  const selectedTheme = getThemeById(appearance.themeId);
  const filteredThemes = useMemo(() => themes.filter((theme) => {
    const categoryMatches = activeFilter === "All" || theme.category === activeFilter;
    const queryMatches = !deferredQuery || `${theme.name} ${theme.category}`.toLowerCase().includes(deferredQuery);
    return categoryMatches && queryMatches;
  }), [activeFilter, deferredQuery]);

  function commit(next: AppearancePreferences) {
    setAppearance(next);
    saveAppearanceSettings(next);
  }

  function resetDefaults() {
    setActiveFilter("All");
    setQuery("");
    commit(defaultAppearanceSettings);
  }

  return (
    <div className="flex h-full flex-col space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold text-foreground">Appearance</h1>
          <p className="text-sm text-muted-foreground">Customize your interface</p>
        </div>
        <button type="button" onClick={resetDefaults} className="text-xs text-muted-foreground underline transition hover:text-foreground">Reset Defaults</button>
      </header>

      <div className="space-y-3 pt-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">Theme</span>
          <span className="text-xs font-medium text-primary">{selectedTheme.name}</span>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {themeFilters.map((filter) => (
            <button key={filter} type="button" onClick={() => setActiveFilter(filter)} className={`rounded-2xl px-3 py-1.5 text-xs transition-all ${activeFilter === filter ? "bg-foreground text-background" : "bg-muted/30 text-muted-foreground hover:text-foreground"}`}>
              {filter}
            </button>
          ))}
        </div>

        <div className="relative">
          <Icon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></Icon>
          <input value={query} onChange={(event) => setQuery(event.target.value)} className="h-9 w-full rounded-2xl border-0 bg-muted/30 pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-0" placeholder="Search themes..." />
        </div>

        <div className="relative -mx-1">
          <button type="button" onClick={() => themeRowRef.current?.scrollBy({ left: 420, behavior: "smooth" })} className="absolute right-0 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-xl border border-border/50 bg-background/70 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground" aria-label="Scroll themes">
            <Icon className="h-5 w-5"><path d="m9 18 6-6-6-6" /></Icon>
          </button>
          <div ref={themeRowRef} className="scrollbar-thin overflow-x-auto pb-2 px-1">
            {filteredThemes.length > 0 ? (
              <div className="flex w-max gap-2">
                {filteredThemes.map((theme) => (
                  <ThemePreviewCard key={theme.id} theme={theme} selected={appearance.themeId === theme.id} onSelect={() => commit({ ...appearance, themeId: theme.id })} />
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-border/50 bg-muted/20 p-4 text-sm text-muted-foreground">No themes match your search.</div>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-2 pt-2">
        <span className="text-xs font-medium text-muted-foreground">Layout Style</span>
        <div className="flex gap-2 overflow-x-auto pb-1">
          <LayoutPreviewButton value="classic" active={appearance.layout === "classic"} onSelect={() => commit({ ...appearance, layout: "classic" })} />
          <LayoutPreviewButton value="modern" active={appearance.layout === "modern"} onSelect={() => commit({ ...appearance, layout: "modern" })} />
        </div>
      </div>

      <div className="grid gap-4 pt-2 sm:grid-cols-2">
        <label className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground">Font Family</span>
          <AppearanceSelect value={appearance.font} options={Object.entries(fontOptions) as Array<[AppearancePreferences["font"], { label: string; css: string }]>} onChange={(font) => commit({ ...appearance, font })} />
        </label>
        <label className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground">Corner Radius</span>
          <AppearanceSelect value={appearance.radius} options={Object.entries(radiusOptions) as Array<[AppearancePreferences["radius"], { label: string; css: string }]>} onChange={(radius) => commit({ ...appearance, radius })} />
        </label>
      </div>

      {appearance.font === "Custom" ? (
        <div className="space-y-3 rounded-2xl border border-border/50 bg-muted/20 p-3 animate-in fade-in slide-in-from-top-2">
          <label className="block space-y-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Font Import URL</span>
            <input value={appearance.customFontUrl ?? ""} onChange={(event) => commit({ ...appearance, customFontUrl: event.target.value })} placeholder="https://fonts.googleapis.com/css2?family=..." className="h-8 w-full rounded-xl border border-border/50 bg-muted/30 px-3 text-xs text-foreground outline-none focus-visible:border-primary/50" />
          </label>
          <label className="block space-y-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Font Family Name</span>
            <input value={appearance.customFontFamily ?? ""} onChange={(event) => commit({ ...appearance, customFontFamily: event.target.value })} placeholder="e.g. 'Press Start 2P'" className="h-8 w-full rounded-xl border border-border/50 bg-muted/30 px-3 text-xs text-foreground outline-none focus-visible:border-primary/50" />
          </label>
          <p className="text-[10px] italic text-muted-foreground">Import any font from Google Fonts or a direct CSS link.</p>
        </div>
      ) : null}

      <div className="grid gap-3 pt-2 sm:grid-cols-[128px_1fr] sm:items-center">
        <div className="luna-logo-mark flex h-20 w-32 items-center justify-center overflow-hidden rounded-xl border border-border/50">
          <Image src={logo} alt="Luna themed logo preview" className="luna-logo-image h-16 w-16 object-contain" priority />
        </div>
        <div className="rounded-xl border border-border/50 bg-muted/20 p-3">
          <p className="text-sm font-semibold text-foreground">Contrast-safe tokens</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">Every theme updates foreground, muted text, borders, primary contrast, and the Luna logo filter together so labels stay readable.</p>
        </div>
      </div>
    </div>
  );
}

function SettingsPanel({ tab, settings, onSettingsChanged }: { tab: SettingsTab; settings: ModelSettings; onSettingsChanged: () => void }) {
  if (tab === "appearance") return <AppearanceSettings />;
  if (tab === "models") return <ModelsSettings settings={settings} onSettingsChanged={onSettingsChanged} />;
  if (tab === "system") return <SystemSettings />;
  if (tab === "data") return <DataStorageSettings />;
  if (tab === "hotkeys") return <HotkeysSettings />;
  return <AboutSettings />;
}

function AppLoading() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-5 text-foreground transition-colors duration-200" aria-live="polite" aria-busy="true">
      <DotMatrix />
      <p className="text-sm font-medium text-muted-foreground">Loading Luna...</p>
    </div>
  );
}

type WizardStep = "details" | "fetching" | "selecting";

function ModelsSettings({ settings, onSettingsChanged }: { settings: ModelSettings; onSettingsChanged: () => void }) {
  const [step, setStep] = useState<WizardStep>("details");
  const [activeEndpointId, setActiveEndpointId] = useState(settings.selected?.endpointId ?? settings.endpoints[0]?.id ?? "");
  const [searchQuery, setSearchQuery] = useState("");
  const [addingEndpoint, setAddingEndpoint] = useState(false);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [manualModels, setManualModels] = useState("");
  const [fetchError, setFetchError] = useState("");
  const [savingEndpoint, setSavingEndpoint] = useState(false);

  const manualModelList = useMemo(() => manualModels.split(/[\n,]/).map((item) => item.trim()).filter(Boolean), [manualModels]);
  const selectedEndpointId = settings.selected?.endpointId;
  const validActiveEndpointId = settings.endpoints.some((endpoint) => endpoint.id === activeEndpointId) ? activeEndpointId : "";
  const fallbackEndpointId = selectedEndpointId && settings.endpoints.some((endpoint) => endpoint.id === selectedEndpointId) ? selectedEndpointId : settings.endpoints[0]?.id;
  const activeEndpoint = settings.endpoints.find((endpoint) => endpoint.id === (validActiveEndpointId || fallbackEndpointId));
  const filteredActiveModels = useMemo(() => {
    if (!activeEndpoint) return [];
    const query = searchQuery.trim().toLowerCase();
    if (!query) return activeEndpoint.models;
    return activeEndpoint.models.filter((model) => model.toLowerCase().includes(query));
  }, [activeEndpoint, searchQuery]);

  async function handleFetchModels() {
    if (!name.trim() || !baseUrl.trim()) return;
    setStep("fetching");
    setFetchError("");
    try {
      const models = await fetchModels(baseUrl, apiKey || undefined);
      if (models.length === 0) throw new Error("The endpoint did not return any models. Enter model IDs manually or check /models support.");
      setFetchedModels(models);
      setSelectedModels(new Set(models));
      setStep("selecting");
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : "Failed to fetch models");
      setStep("details");
    }
  }

  function toggleModel(model: string) {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      if (next.has(model)) next.delete(model); else next.add(model);
      return next;
    });
  }

  async function handleAddEndpoint() {
    if (!name.trim() || !baseUrl.trim() || selectedModels.size === 0) return;
    setFetchError("");
    setSavingEndpoint(true);
    try {
      upsertEndpoint({ name, baseUrl, apiKey, models: Array.from(selectedModels) });
      recordUiEvent("ui.provider.saved", { provider: name.trim(), baseUrl: baseUrl.trim(), models: selectedModels.size, mode: "fetched" });
      setName("");
      setBaseUrl("");
      setApiKey("");
      setFetchedModels([]);
      setSelectedModels(new Set());
      setManualModels("");
      setStep("details");
      setAddingEndpoint(false);
      onSettingsChanged();
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : "Failed to save provider locally");
    } finally {
      setSavingEndpoint(false);
    }
  }

  async function handleAddManualEndpoint() {
    if (!name.trim() || !baseUrl.trim() || manualModelList.length === 0) return;
    setFetchError("");
    setSavingEndpoint(true);
    try {
      upsertEndpoint({ name, baseUrl, apiKey, models: manualModelList });
      recordUiEvent("ui.provider.saved", { provider: name.trim(), baseUrl: baseUrl.trim(), models: manualModelList.length, mode: "manual" });
      setName("");
      setBaseUrl("");
      setApiKey("");
      setFetchedModels([]);
      setSelectedModels(new Set());
      setManualModels("");
      setStep("details");
      setAddingEndpoint(false);
      onSettingsChanged();
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : "Failed to save provider locally");
    } finally {
      setSavingEndpoint(false);
    }
  }

  function handleCancel() {
    setName("");
    setBaseUrl("");
    setApiKey("");
    setFetchedModels([]);
    setSelectedModels(new Set());
    setManualModels("");
    setFetchError("");
    setStep("details");
    setAddingEndpoint(false);
  }

  return (
    <div className="flex h-full flex-col space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-bold text-foreground">Models</h1>
        <p className="text-sm text-muted-foreground">Manage AI models and providers.</p>
      </header>

      <section className="space-y-3">
        {step === "details" && !addingEndpoint ? (
          <button type="button" onClick={() => setAddingEndpoint(true)} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-border/50 bg-background text-sm font-medium text-foreground transition-colors hover:bg-muted/40">
            <Icon className="h-4 w-4"><path d="M12 5v14" /><path d="M5 12h14" /></Icon>
            Add provider
          </button>
        ) : step === "details" ? (
          <div key="provider-details" className="space-y-5 rounded-2xl border border-border/50 bg-background p-5 animate-in fade-in-0 slide-in-from-bottom-2 duration-150">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Add provider</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">Connect any OpenAI-compatible endpoint.</p>
              </div>
              <button type="button" onClick={handleCancel} className="rounded-xl px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/50">Cancel</button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block space-y-2"><span className="text-xs font-medium text-muted-foreground">Name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="My provider" className="h-11 w-full rounded-xl border border-border/50 bg-background px-3 text-sm outline-none transition focus:border-border" /></label>
              <label className="block space-y-2"><span className="text-xs font-medium text-muted-foreground">Base URL</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" className="h-11 w-full rounded-xl border border-border/50 bg-background px-3 text-sm outline-none transition focus:border-border" /></label>
            </div>
            <label className="block space-y-2"><span className="text-xs font-medium text-muted-foreground">API key</span><input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" placeholder="Optional for local endpoints" className="h-11 w-full rounded-xl border border-border/50 bg-background px-3 text-sm outline-none transition focus:border-border" /></label>
            <label className="block space-y-2"><span className="text-xs font-medium text-muted-foreground">Manual model IDs</span><textarea value={manualModels} onChange={(event) => setManualModels(event.target.value)} placeholder="gpt-4.1\nclaude-sonnet-4-5\nlocal-model" className="min-h-28 w-full resize-none rounded-xl border border-border/50 bg-background px-3 py-2 text-sm outline-none transition focus:border-border" /><p className="text-[10px] text-muted-foreground">Use this when your endpoint does not expose `/models`.</p></label>
            {fetchError ? <p className="text-xs text-danger">{fetchError}</p> : null}
            <div className="grid gap-2 sm:grid-cols-2">
              <button type="button" onClick={handleFetchModels} disabled={!name.trim() || !baseUrl.trim()} className="h-11 rounded-xl bg-foreground px-4 text-sm font-medium text-background transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">Fetch models</button>
              <button type="button" onClick={handleAddManualEndpoint} disabled={!name.trim() || !baseUrl.trim() || manualModelList.length === 0} className="h-11 rounded-xl border border-border/50 px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50">Save manual ({manualModelList.length})</button>
            </div>
          </div>
        ) : step === "fetching" ? (
          <div key="provider-fetching" className="flex flex-col items-center gap-4 rounded-2xl border border-border/50 bg-muted/30 p-8 animate-in fade-in-0 zoom-in-95 duration-200">
            <DotMatrix />
            <p className="text-sm font-medium text-foreground">Fetching models from endpoint...</p>
            <p className="text-xs text-muted-foreground">{baseUrl}</p>
          </div>
        ) : (
          <div key="provider-selecting" className="space-y-4 rounded-2xl border border-border/50 bg-background p-5 animate-in fade-in-0 slide-in-from-bottom-2 zoom-in-95 duration-200">
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{name}</p>
                <p className="truncate text-xs text-muted-foreground">{baseUrl}</p>
              </div>
              <button type="button" onClick={handleCancel} className="rounded-xl px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/50">Cancel</button>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Select models</p>
              <div className="max-h-52 overflow-y-auto space-y-1 rounded-xl bg-muted/20 p-2">
                {fetchedModels.map((model) => (
                  <label key={model} className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 hover:bg-muted/50">
                    <input type="checkbox" checked={selectedModels.has(model)} onChange={() => toggleModel(model)} className="rounded border-border bg-background text-primary focus:ring-primary" />
                    <ModelIcon modelId={model} className="h-4 w-4 shrink-0 text-primary" />
                    <span className="truncate text-sm font-medium text-foreground">{model}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setStep("details")} className="h-11 flex-1 rounded-xl border border-border/50 px-4 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/50">Back</button>
              <button type="button" onClick={handleAddEndpoint} disabled={selectedModels.size === 0 || savingEndpoint} className="h-11 flex-1 rounded-xl bg-foreground px-4 text-sm font-medium text-background transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">{savingEndpoint ? "Saving..." : `Add endpoint (${selectedModels.size})`}</button>
            </div>
            {fetchError ? <p className="text-xs text-danger">{fetchError}</p> : null}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-foreground">Configured endpoints</h2>
          {settings.endpoints.length > 0 ? <span className="text-xs text-muted-foreground">{settings.endpoints.length} total</span> : null}
        </div>

        {settings.endpoints.length === 0 ? (
          <div className="rounded-xl bg-muted/30 p-4 text-sm text-muted-foreground">No endpoints configured yet. Add an OpenAI-compatible endpoint below.</div>
        ) : (
          <div className="space-y-3">
            {settings.endpoints.map((endpoint) => <EndpointCard key={endpoint.id} endpoint={endpoint} settings={settings} onSettingsChanged={onSettingsChanged} />)}
          </div>
        )}
      </section>

      {settings.endpoints.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Providers</h2>
          <div className="flex flex-wrap gap-2">
            {settings.endpoints.map((endpoint) => {
              const active = activeEndpoint?.id === endpoint.id;
              const configured = settings.selected?.endpointId === endpoint.id;
              return (
                <button
                  key={endpoint.id}
                  type="button"
                  onClick={() => setActiveEndpointId(endpoint.id)}
                  className={`relative flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors ${active ? "bg-foreground text-background" : "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"}`}
                >
                  <span className="max-w-[10rem] truncate">{endpoint.name}</span>
                  {configured ? <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-background" : "bg-foreground/40"}`} aria-label="Selected provider" /> : null}
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {activeEndpoint ? (
        <section className="space-y-4">
          <div className="relative">
            <Icon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></Icon>
            <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search models..." className="h-10 w-full rounded-xl border-0 bg-muted/30 pl-9 pr-3 text-sm text-foreground outline-none transition focus:bg-muted/50" />
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Enabled</p>
            <div className="space-y-1">
              {filteredActiveModels.length > 0 ? filteredActiveModels.map((model) => {
                const active = settings.selected?.endpointId === activeEndpoint.id && settings.selected.model === model;
                return (
                  <button
                    key={model}
                    type="button"
                    onClick={() => { saveModelSettings({ ...settings, selected: { endpointId: activeEndpoint.id, model } }); recordUiEvent("ui.model.selected", { provider: activeEndpoint.name, model }); onSettingsChanged(); }}
                    className={`flex w-full items-center justify-between rounded-xl border p-3 text-left transition-colors ${active ? "border-foreground/40 bg-muted/30" : "border-transparent hover:bg-muted/30"}`}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <ModelIcon modelId={model} className="h-5 w-5 shrink-0 text-primary" />
                      <div className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-foreground">{model}</span>
                        <p className="truncate text-xs text-muted-foreground">{activeEndpoint.name}</p>
                      </div>
                    </div>
                    <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${active ? "bg-foreground" : "bg-muted"}`} aria-label={active ? "Active model" : "Use model"}>
                      <span className={`absolute top-1 h-4 w-4 rounded-full bg-background transition-transform ${active ? "translate-x-6" : "translate-x-1"}`} />
                    </span>
                  </button>
                );
              }) : <div className="rounded-xl bg-muted/20 p-4 text-sm text-muted-foreground">No models match your search.</div>}
            </div>
          </div>
        </section>
      ) : null}

    </div>
  );
}

function EndpointCard({ endpoint, settings, onSettingsChanged }: { endpoint: OpenAiEndpoint; settings: ModelSettings; onSettingsChanged: () => void }) {
  const selectedModel = settings.selected?.endpointId === endpoint.id ? settings.selected.model : null;
  return (
    <div className={`rounded-2xl border bg-background p-4 ${selectedModel ? "border-foreground/35" : "border-border/50"}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <h3 className="truncate text-base font-semibold leading-none text-foreground">{endpoint.name}</h3>
          <div className="space-y-1 text-xs leading-5 text-muted-foreground">
            <p className="truncate"><span className="font-medium text-foreground/70">URL:</span> {endpoint.baseUrl}</p>
            <p><span className="font-medium text-foreground/70">Models:</span> {endpoint.models.length} available</p>
            {selectedModel ? <p className="truncate"><span className="font-medium text-foreground/70">Active:</span> {selectedModel}</p> : null}
          </div>
        </div>
        <button type="button" onClick={() => { deleteEndpoint(endpoint.id); onSettingsChanged(); }} className="h-9 shrink-0 rounded-xl px-3 text-xs font-medium text-muted-foreground transition hover:bg-danger/10 hover:text-danger">Delete</button>
      </div>

    </div>
  );
}

function SystemSettings() {
  return (
    <div className="space-y-6">
      <SectionHeader title="System" description="Customize the prompt Luna prepends before calling the configured model." />
      <label className="block space-y-2"><span className="text-sm font-medium text-foreground">System Prompt</span><textarea maxLength={1000} placeholder="You are Luna, a microservices-aware AI assistant..." className="min-h-[180px] w-full resize-none rounded-2xl border border-border/50 bg-muted/30 p-3 text-sm outline-none" /></label>
      <button type="button" className="rounded-xl bg-primary px-3 py-2 text-sm text-primary-foreground">Save</button>
    </div>
  );
}

function DataStorageSettings() {
  return (
    <div className="space-y-6">
      <SectionHeader title="Data Storage" description="Manage local model settings and persisted chat data." />
      {[
        ["Model endpoints", "Stored in this browser with localStorage so no provider-settings service is needed."],
        ["Chat history", "Stored by Activity Service after Chat Service publishes Kafka events."],
        ["Audit logs", "Stored by Activity Service and exposed in the Activity page."]
      ].map(([name, description]) => <div key={name} className="rounded-2xl bg-muted/30 p-4"><span className="text-sm font-semibold text-foreground">{name}</span><p className="mt-0.5 text-xs text-muted-foreground">{description}</p></div>)}
    </div>
  );
}

function HotkeysSettings() {
  const hotkeys = [["⌘ N", "New chat"], ["⌘ ,", "Open settings"], ["⌘ M", "Change model"], ["Esc", "Close dialogs"], ["Enter", "Send message"], ["Shift + Enter", "New line"]];
  return (
    <div className="space-y-6">
      <SectionHeader title="Hotkeys" description="Keyboard shortcuts to navigate faster." />
      <div className="space-y-1">{hotkeys.map(([key, description]) => <div key={key} className="flex items-center justify-between rounded-xl bg-muted/30 p-3"><span className="text-sm font-medium text-foreground">{description}</span><kbd className="rounded-lg border border-border/50 bg-background px-2.5 py-1 font-mono text-xs text-muted-foreground">{key}</kbd></div>)}</div>
      <div className="rounded-xl border border-border/50 bg-muted/30 p-4"><span className="text-sm font-semibold text-foreground">Pro Tip</span><p className="mt-0.5 text-xs text-muted-foreground">On Windows and Linux, use Ctrl instead of ⌘.</p></div>
    </div>
  );
}

function AboutSettings() {
  return (
    <div className="space-y-6">
      <SectionHeader title="About" description="Luna microservices chat platform." />
      <div className="rounded-2xl bg-muted/30 p-4"><p className="text-sm font-semibold text-foreground">Luna</p><p className="mt-1 text-xs text-muted-foreground">Next.js web shell, API Gateway, three Node.js microservices, gRPC, Kafka 4.2, SQLite, REST, and GraphQL.</p></div>
      <p className="border-t border-border/40 pt-4 text-center text-xs text-muted-foreground">© 2026 Luna</p>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const workspaceId = useWorkspaceId();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [modelOpen, setModelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("models");
  const [modelSettings, setModelSettings] = useState<ModelSettings>({ endpoints: [] });
  const [appearanceSettings, setAppearanceSettings] = useState<AppearancePreferences>(defaultAppearanceSettings);
  const [hydrated, setHydrated] = useState(false);
  const canSelectModel = pathname === "/" || pathname.startsWith("/chat");
  const selectedHeaderModel = hydrated ? selectedModelLabel(modelSettings) : "Select model";

  useEffect(() => {
    const nextAppearance = loadAppearanceSettings();
    applyAppearanceSettings(nextAppearance);
    queueMicrotask(() => {
      setAppearanceSettings(nextAppearance);
      setModelSettings(loadModelSettings());
      setHydrated(true);
    });
  }, []);

  const refreshModelSettings = useCallback(() => {
    setModelSettings(loadModelSettings());
  }, []);

  const refreshAppearanceSettings = useCallback(() => {
    const nextAppearance = loadAppearanceSettings();
    applyAppearanceSettings(nextAppearance);
    setAppearanceSettings(nextAppearance);
  }, []);

  const openSettings = useCallback((tab: SettingsTab = "models") => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);

  useEffect(() => {
    window.addEventListener(MODEL_SETTINGS_CHANGED, refreshModelSettings);
    return () => window.removeEventListener(MODEL_SETTINGS_CHANGED, refreshModelSettings);
  }, [refreshModelSettings]);

  useEffect(() => {
    window.addEventListener(APPEARANCE_SETTINGS_CHANGED, refreshAppearanceSettings);
    return () => window.removeEventListener(APPEARANCE_SETTINGS_CHANGED, refreshAppearanceSettings);
  }, [refreshAppearanceSettings]);

  useEffect(() => {
    function onOpenSettings(event: Event) {
      const detail = (event as CustomEvent<OpenSettingsDetail>).detail;
      openSettings(detail?.tab ?? "models");
    }

    window.addEventListener("luna:open-settings", onOpenSettings);
    return () => window.removeEventListener("luna:open-settings", onOpenSettings);
  }, [openSettings]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (canSelectModel && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "m") {
        event.preventDefault();
        setModelOpen(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        requestNewChat();
      }
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        openSettings("models");
      }
      if (event.key === "Escape") {
        setModelOpen(false);
        setSettingsOpen(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canSelectModel, openSettings]);

  if (!hydrated) return <AppLoading />;

  return (
    <div className={`${appearanceSettings.layout === "classic" ? "classic-layout" : "modern-layout"} relative flex h-screen overflow-hidden bg-background`}>
      <div className="relative z-10 flex h-full w-full">
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} onSettings={() => openSettings("models")} workspaceId={workspaceId} />
        <div className="z-10 flex min-w-0 flex-1 flex-col">
          <div className="flex flex-1 overflow-hidden">
            <main className={`modern-chat-container relative flex flex-1 flex-col transition-all duration-300 ${canSelectModel ? "items-center overflow-hidden pb-2" : "items-stretch overflow-y-auto overflow-x-hidden pb-8"}`}>
              <header className="sticky top-0 z-30 flex h-14 w-full items-center justify-between px-2 transition-all duration-200">
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => setSidebarOpen((value) => !value)} className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-muted-foreground transition hover:bg-muted/50 hover:text-foreground" aria-label="Toggle sidebar">
                    <Icon>{sidebarOpen ? <><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /></> : <><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /></>}</Icon>
                  </button>
                  {canSelectModel ? (
                    <button type="button" onClick={() => setModelOpen(true)} className="inline-flex h-9 items-center justify-center gap-2 rounded-2xl px-2 py-2 text-sm font-medium transition-all hover:bg-muted/50 focus-visible:outline-none">
                      <span key={selectedHeaderModel} className="luna-model-trigger-spawn inline-flex min-w-0 items-center gap-2">
                        {hydrated ? <ModelIcon modelId={selectedHeaderModel} className="h-4 w-4 text-primary" /> : <span className="h-4 w-4 text-primary" aria-label="Model" />}
                        <span className="flex-1 truncate text-left font-medium sm:inline">{selectedHeaderModel}</span>
                      </span>
                      <kbd className="pointer-events-none hidden h-5 select-none items-center gap-1 rounded border border-border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground sm:flex"><span className="text-xs">⌘</span>M</kbd>
                    </button>
                  ) : null}
                </div>
                <div className="flex items-center gap-1.5">
                  <nav className="flex items-center gap-1.5" aria-label="Workspace navigation">
                    <HeaderAction href="/logs" active={pathname.startsWith("/logs")} label="Activity">
                      <Icon className="h-3.5 w-3.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /><path d="M16 13H8" /><path d="M16 17H8" /></Icon>
                    </HeaderAction>
                  </nav>
                </div>
              </header>
              {children}
            </main>
          </div>
        </div>
      </div>
      {canSelectModel && modelOpen ? <ModelDialog open={modelOpen} settings={modelSettings} onSelect={refreshModelSettings} onClose={() => setModelOpen(false)} onOpenSettings={() => { setModelOpen(false); openSettings("models"); }} /> : null}
      {settingsOpen ? <SettingsDialog key={settingsTab} open={settingsOpen} initialTab={settingsTab} settings={modelSettings} workspaceId={workspaceId} onSettingsChanged={refreshModelSettings} onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}
