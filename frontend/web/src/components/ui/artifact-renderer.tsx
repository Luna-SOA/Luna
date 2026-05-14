"use client";

import { memo } from "react";

interface ArtifactRendererProps {
  type: "mermaid" | "echarts" | "chart" | "csv" | "tsv";
  content: string;
  title?: string;
}

function artifactTitle(type: ArtifactRendererProps["type"], title?: string) {
  if (title) return title;
  if (type === "mermaid") return "Diagram source";
  if (type === "csv" || type === "tsv") return "Table data";
  return "Chart source";
}

export const ArtifactRenderer = memo(function ArtifactRenderer({ type, content, title }: ArtifactRendererProps) {
  return (
    <section className="not-prose my-4 overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
      <div className="border-b border-border/45 bg-muted/20 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{artifactTitle(type, title)}</p>
        <p className="mt-1 text-xs text-muted-foreground">Rendering libraries were removed to keep the project lightweight and focused on the microservices assignment.</p>
      </div>
      <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap p-4 font-mono text-xs leading-5 text-foreground">{content}</pre>
    </section>
  );
});

export function isArtifactBlock(code: string): { type: "mermaid" | "echarts" | "chart" | "csv" | "tsv" } | null {
  const trimmed = code.trim();
  const normalized = trimmed.toLowerCase();

  if (/^(?:sequenceDiagram|classDiagram|stateDiagram|erDiagram|flowchart|graph\s|mindmap|timeline|gantt|journey|pie)/i.test(trimmed)) return { type: "mermaid" };
  if (normalized.startsWith("mermaid\n") || normalized.startsWith("mermaid ")) return { type: "mermaid" };
  if (/\b(?:series|xAxis|yAxis|dataset|tooltip)\b/.test(trimmed)) return { type: "echarts" };

  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  if (lines.length >= 2) {
    const first = lines[0] ?? "";
    const second = lines[1] ?? "";
    if ((first.includes(",") && second.includes(",")) || (first.includes("\t") && second.includes("\t"))) return { type: first.includes("\t") ? "tsv" : "csv" };
  }

  return null;
}
