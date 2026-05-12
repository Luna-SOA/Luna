"use client";

import { isValidElement, memo, useEffect, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import { cn } from "@/components/ui/cn";
import { ArtifactRenderer, isArtifactBlock } from "@/components/ui/artifact-renderer";

function normalizeMathOutsideInlineCode(value: string) {
  const inlineCodePattern = /(`+)([\s\S]*?)\1/g;
  let cursor = 0;
  let result = "";
  let match: RegExpExecArray | null;

  function normalizeSegment(segment: string) {
    return segment
      .replace(/\u202f/g, " ")
      .replace(/\\begin\{equation\*?\}([\s\S]*?)\\end\{equation\*?\}/g, (_match, body: string) => `\n$$\n${body.trim()}\n$$\n`)
      .replace(/\\\[([\s\S]*?)\\\]/g, (_match, body: string) => `\n$$\n${body.trim()}\n$$\n`)
      .replace(/\\\((.+?)\\\)/g, (_match, body: string) => `$${body.trim()}$`);
  }

  while ((match = inlineCodePattern.exec(value)) !== null) {
    result += normalizeSegment(value.slice(cursor, match.index));
    result += match[0];
    cursor = inlineCodePattern.lastIndex;
  }

  return result + normalizeSegment(value.slice(cursor));
}

export function normalizeMarkdownMath(content: string) {
  const fencePattern = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
  let cursor = 0;
  let result = "";
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(content)) !== null) {
    result += normalizeMathOutsideInlineCode(content.slice(cursor, match.index));
    result += match[0];
    cursor = fencePattern.lastIndex;
  }

  return result + normalizeMathOutsideInlineCode(content.slice(cursor));
}

function textFromNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join("");
  if (isValidElement(node)) return textFromNode((node.props as { children?: ReactNode }).children);
  return "";
}

const previewableLanguages = new Set(["html", "svg", "xml"]);
const defaultCodePanelWidth = 820;
const minCodePanelWidth = 420;
const minChatWidthWithCodePanel = 480;

type CodePanelPayload = {
  id: string;
  code: string;
  language: string;
  highlightedCode: ReactNode;
  initialTab: "code" | "preview";
};

function codePanelWidthForViewport() {
  if (typeof window === "undefined") return defaultCodePanelWidth;
  const maxPanelWidth = Math.max(minCodePanelWidth, window.innerWidth - minChatWidthWithCodePanel - 28);
  return Math.min(defaultCodePanelWidth, maxPanelWidth);
}

function isPreviewable(language: string) {
  return previewableLanguages.has(language.toLowerCase());
}

function languageFromClassName(className?: string) {
  if (!className) return "";
  const languageMatch = /(?:^|\s)language-([\w+-]+)/i.exec(className);
  if (languageMatch?.[1]) return languageMatch[1].toLowerCase();
  return className.split(/\s+/).find((part) => part && part !== "hljs")?.toLowerCase() ?? "";
}

function languageFromCode(code: string) {
  if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(code)) return "html";
  if (/^\s*<svg\b/i.test(code)) return "svg";
  return "";
}

function extensionForLanguage(language: string) {
  if (language === "html") return "html";
  if (language === "svg") return "svg";
  if (language === "xml") return "xml";
  if (language === "tsx") return "tsx";
  if (language === "jsx") return "jsx";
  if (language === "typescript" || language === "ts") return "ts";
  if (language === "javascript" || language === "js") return "js";
  if (language === "css") return "css";
  return language || "txt";
}

function previewTitle(code: string, language: string) {
  if (language === "html") {
    const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(code)?.[1]?.replace(/\s+/g, " ").trim();
    if (title) return title;
  }
  if (language === "svg") return "SVG Preview";
  return "Preview";
}

function previewMimeType(language: string) {
  if (language === "html") return "text/html";
  if (language === "svg") return "image/svg+xml";
  if (language === "xml") return "application/xml";
  return "text/plain";
}

function fenceStandaloneHtmlDocuments(content: string) {
  if (/```|~~~/.test(content)) return content;
  return content.replace(/(^|\n)(\s*(?:<!doctype\s+html|<html\b)[\s\S]*?<\/html>\s*)/i, (_match, prefix: string, html: string) => `${prefix}\n\`\`\`html\n${html.trim()}\n\`\`\`\n`);
}

function IconExpand() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

function IconDownload() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" x2="12" y1="15" y2="3" />
    </svg>
  );
}

function IconCopy() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function IconExternal() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

function FullscreenPanel({ code, language, highlightedCode, initialTab, onClose }: { code: string; language: string; highlightedCode: ReactNode; initialTab: "code" | "preview"; onClose: () => void }) {
  const canPreview = isPreviewable(language);
  const [tab, setTab] = useState<"code" | "preview">(canPreview ? initialTab : "code");
  const [copied, setCopied] = useState(false);
  const [panelWidth, setPanelWidth] = useState(codePanelWidthForViewport);
  const title = previewTitle(code, language);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("luna:code-panel-layout", { detail: { open: true, width: panelWidth } }));
  }, [panelWidth]);

  useEffect(() => {
    return () => {
      window.dispatchEvent(new CustomEvent("luna:code-panel-layout", { detail: { open: false, width: 0 } }));
    };
  }, []);

  function handleCopy() {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    }).catch(() => {});
  }

  function handleDownload() {
    const blob = new Blob([code], { type: previewMimeType(language) });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `code.${extensionForLanguage(language)}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleOpenPreview() {
    const blob = new Blob([code], { type: previewMimeType(language) });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const onMove = (moveEvent: PointerEvent) => {
      const maxWidth = Math.max(minCodePanelWidth, window.innerWidth - minChatWidthWithCodePanel - 28);
      const nextWidth = Math.min(maxWidth, Math.max(minCodePanelWidth, window.innerWidth - moveEvent.clientX - 12));
      setPanelWidth(nextWidth);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="luna-code-panel-layer pointer-events-none fixed inset-0 z-[90]">
      <aside className="luna-code-panel pointer-events-auto absolute bottom-3 right-3 top-3 flex max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-panel md:bottom-4 md:right-4 md:top-4" style={{ width: `min(${panelWidth}px, calc(100vw - 1.5rem))` }}>
        <div onPointerDown={startResize} className="group absolute bottom-0 left-0 top-0 z-20 hidden w-1.5 cursor-col-resize transition-colors hover:bg-primary/20 md:block">
          <div className="absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground">
              <circle cx="9" cy="12" r="1" /><circle cx="9" cy="5" r="1" /><circle cx="9" cy="19" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="15" cy="5" r="1" /><circle cx="15" cy="19" r="1" />
            </svg>
          </div>
        </div>
        <div className="z-10 flex flex-wrap items-center justify-between gap-2 border-b border-border/50 bg-background/90 px-4 py-3 backdrop-blur">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{language || "code"}</span>
          </div>
          {canPreview ? (
            <div className="flex items-center rounded-3xl border border-border/60 bg-muted/60 p-0.5">
              <button onClick={() => setTab("code")} className={cn("rounded-full px-3 py-1 text-xs font-medium transition-colors", tab === "code" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>Code</button>
              <button onClick={() => setTab("preview")} className={cn("rounded-full px-3 py-1 text-xs font-medium transition-colors", tab === "preview" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>Preview</button>
            </div>
          ) : null}
          <div className="flex items-center gap-1 rounded-lg border border-border/30 bg-background/70 p-0.5">
            {canPreview ? <button type="button" onClick={handleOpenPreview} className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" title="Open preview in new tab"><IconExternal /></button> : null}
            <button type="button" onClick={handleDownload} className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" title="Download"><IconDownload /></button>
            <button type="button" onClick={handleCopy} className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" title="Copy code">{copied ? <IconCheck /> : <IconCopy />}</button>
            <button type="button" onClick={onClose} className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" title="Close"><IconClose /></button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === "code" ? (
            <pre className="luna-markdown scrollbar-thin h-full overflow-auto overscroll-contain bg-muted/20 p-6 text-left font-mono text-sm leading-6 text-foreground">{highlightedCode}</pre>
          ) : (
            <div className="flex h-full flex-col bg-card">
              <div className="flex items-center gap-2 border-b border-border/50 p-2">
                <input className="h-9 min-w-0 flex-1 rounded-md border-0 bg-transparent px-3 py-1 text-sm text-foreground outline-none" readOnly value={title} aria-label="Preview title" />
                <button type="button" onClick={handleOpenPreview} className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" title="Open in new tab"><IconExternal /></button>
              </div>
              <iframe srcDoc={code} sandbox="allow-scripts allow-forms allow-popups" className="h-full w-full flex-1 border-0 bg-white" title="Preview" />
            </div>
          )}
        </div>
      </aside>
    </div>,
    document.body
  );
}

const CodeBlock = memo(function CodeBlock({ children, className }: { children?: ReactNode; className?: string }) {
  const code = textFromNode(children).replace(/\n$/, "");
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<"code" | "preview">("code");
  const language = languageFromClassName(className) || languageFromCode(code);

  const canPreview = isPreviewable(language);
  const title = previewTitle(code, language);
  const inferredArtifact = isArtifactBlock(code);

  function handleCopy() {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    }).catch(() => {});
  }

  function handleDownload() {
    const blob = new Blob([code], { type: previewMimeType(language) });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `code.${extensionForLanguage(language)}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleOpenPreview() {
    const blob = new Blob([code], { type: previewMimeType(language) });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function handleOpenPanel() {
    window.dispatchEvent(new CustomEvent<CodePanelPayload>("luna:open-code-panel", {
      detail: {
        id: crypto.randomUUID(),
        code,
        language,
        highlightedCode: children,
        initialTab: canPreview ? tab : "code"
      }
    }));
  }

  if (language === "echarts" || language === "mermaid" || language === "csv" || language === "tsv" || language === "x-csv" || language === "xcsv" || language === "xscv" || language === "tab-separated-values") {
    const artifactType: "echarts" | "mermaid" | "csv" | "tsv" = language === "x-csv" || language === "xcsv" || language === "xscv" ? "csv" : language === "tab-separated-values" ? "tsv" : language;
    return <ArtifactRenderer content={code} type={artifactType} />;
  }

  if (!language && inferredArtifact) {
    return <ArtifactRenderer content={code} type={inferredArtifact.type} />;
  }

  return (
    <>
      <div className="not-prose group relative my-4 max-w-full overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
        <div className="relative flex flex-wrap items-center justify-between gap-2 border-b border-border/45 bg-muted/20 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{language || "code"}</span>
          </div>
          {canPreview ? (
            <div className="order-last w-full sm:order-none sm:absolute sm:left-1/2 sm:top-1/2 sm:w-auto sm:-translate-x-1/2 sm:-translate-y-1/2">
              <div className="flex w-full items-center justify-center gap-1 rounded-3xl border border-border bg-background p-0.5 sm:w-auto">
                <button type="button" onClick={() => setTab("code")} className={cn("flex-1 rounded-3xl px-2.5 py-1 text-xs font-medium transition-colors sm:flex-none", tab === "code" ? "border border-border/40 bg-secondary text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>Code</button>
                <button type="button" onClick={() => setTab("preview")} className={cn("flex flex-1 items-center justify-center rounded-3xl px-2.5 py-1 text-xs font-medium transition-colors sm:flex-none", tab === "preview" ? "border border-border/40 bg-secondary text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>Preview</button>
              </div>
            </div>
          ) : null}
          <div className={cn("flex items-center gap-1", canPreview ? "ml-auto sm:ml-0" : "ml-auto")}>
            <button type="button" onClick={handleOpenPanel} className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" title="Open in Panel">
              <IconExpand />
            </button>
            {canPreview ? <button type="button" onClick={handleOpenPreview} className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" title="Open preview in new tab"><IconExternal /></button> : null}
            <button type="button" onClick={handleDownload} className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" title="Download">
              <IconDownload />
            </button>
            <button type="button" onClick={handleCopy} className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" title="Copy code">
              {copied ? <IconCheck /> : <IconCopy />}
            </button>
          </div>
        </div>
        <div className="relative w-full">
          {tab === "code" ? (
            <div className="scrollbar-thin max-h-[640px] overflow-auto overscroll-contain p-4">
              <pre className="m-0 bg-transparent text-left font-mono text-sm leading-6 text-foreground">{children}</pre>
            </div>
          ) : (
            <div className="relative flex min-h-[420px] flex-col bg-card md:min-h-[520px]">
              <div className="flex items-center gap-2 border-b border-border/45 p-2">
                <input className="h-9 min-w-0 flex-1 rounded-md border-0 bg-transparent px-3 py-1 text-sm text-foreground outline-none" readOnly value={title} aria-label="Preview title" />
                <button type="button" onClick={handleOpenPreview} className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" title="Open in new tab"><IconExternal /></button>
              </div>
              <iframe srcDoc={code} sandbox="allow-scripts allow-forms allow-popups" className="min-h-[380px] w-full flex-1 border-0 bg-white" title="Preview" />
            </div>
          )}
        </div>
      </div>
    </>
  );
});

export function CodePanelHost() {
  const [panel, setPanel] = useState<CodePanelPayload | null>(null);

  useEffect(() => {
    function onOpenCodePanel(event: Event) {
      const detail = (event as CustomEvent<CodePanelPayload>).detail;
      if (!detail?.code) return;
      setPanel(detail);
    }

    function onUpdateCodePanel(event: Event) {
      const detail = (event as CustomEvent<CodePanelPayload>).detail;
      if (!detail?.id) return;
      setPanel((current) => current?.id === detail.id ? { ...current, ...detail } : current);
    }

    window.addEventListener("luna:open-code-panel", onOpenCodePanel);
    window.addEventListener("luna:update-code-panel", onUpdateCodePanel);
    return () => {
      window.removeEventListener("luna:open-code-panel", onOpenCodePanel);
      window.removeEventListener("luna:update-code-panel", onUpdateCodePanel);
    };
  }, []);

  if (!panel) return null;

  return (
    <FullscreenPanel
      key={panel.id}
      code={panel.code}
      language={panel.language}
      highlightedCode={panel.highlightedCode}
      initialTab={panel.initialTab}
      onClose={() => setPanel(null)}
    />
  );
}

export function MarkdownMessage({ content, className }: { content: string; className?: string }) {
  const normalizedContent = normalizeMarkdownMath(fenceStandaloneHtmlDocuments(content));

  return (
    <div className={cn("luna-markdown prose prose-sm max-w-none text-foreground md:prose-base dark:prose-invert", className)}>
      <ReactMarkdown
        components={{
          pre: ({ children }) => {
            const codeEl = children as ReactNode;
            let codeClassName = "";
            const firstCodeChild = Array.isArray(codeEl) ? codeEl.find(isValidElement) : codeEl;
            if (isValidElement(firstCodeChild) && (firstCodeChild.props as { className?: string }).className) {
              codeClassName = (firstCodeChild.props as { className?: string }).className ?? "";
            }
            return <CodeBlock className={codeClassName}>{codeEl}</CodeBlock>;
          },
          code: ({ className: codeClassName, children }) => (
            <code className={cn(codeClassName ? "whitespace-pre font-mono text-sm" : "rounded-md border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[0.92em] text-foreground", codeClassName)}>{children}</code>
          ),
          p: ({ children }) => <p className="my-2 whitespace-pre-wrap first:mt-0 last:mb-0">{children}</p>,
          a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer" className="font-medium text-primary underline underline-offset-4 hover:opacity-80">{children}</a>,
          h1: ({ children }) => <h1 className="mb-3 mt-4 text-2xl font-bold tracking-tight text-foreground first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 mt-4 text-xl font-bold tracking-tight text-foreground first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-2 mt-3 text-base font-semibold text-foreground first:mt-0">{children}</h3>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className="pl-1 marker:text-muted-foreground">{children}</li>,
          blockquote: ({ children }) => <blockquote className="my-3 border-l-2 border-primary/50 bg-muted/30 py-2 pl-4 text-muted-foreground">{children}</blockquote>,
          table: ({ children }) => <div className="my-4 overflow-x-auto"><table className="w-full caption-bottom border-collapse text-left text-sm">{children}</table></div>,
          thead: ({ children }) => <thead className="border-border/50 bg-muted/20 [&_tr]:border-b">{children}</thead>,
          tbody: ({ children }) => <tbody className="[&_tr:last-child]:border-0">{children}</tbody>,
          tr: ({ children }) => <tr className="border-b border-border/50 transition-colors hover:bg-muted/30">{children}</tr>,
          th: ({ children }) => <th className="h-10 px-4 py-2 text-left align-middle font-semibold text-foreground">{children}</th>,
          td: ({ children }) => <td className="p-4 align-middle text-muted-foreground">{children}</td>,
          hr: () => <hr className="my-4 border-border" />,
          strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>
        }}
      >
        {normalizedContent}
      </ReactMarkdown>
    </div>
  );
}
