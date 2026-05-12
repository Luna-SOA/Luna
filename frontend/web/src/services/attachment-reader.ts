export interface ReadAttachmentResult {
  content: string;
  truncated: boolean;
  method: "text" | "unsupported";
  readable: boolean;
}

function trimContent(value: string, limit: number) {
  const normalized = value.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return {
    content: normalized.slice(0, limit),
    truncated: normalized.length > limit,
  };
}

function isLikelyText(file: File) {
  if (file.type.startsWith("text/")) return true;
  if (/json|xml|yaml|csv|javascript|typescript|markdown/i.test(file.type)) return true;
  return /\.(txt|md|markdown|json|csv|xml|yaml|yml|js|jsx|ts|tsx|css|html|sql|log)$/i.test(file.name);
}

export async function readAttachmentFile(file: File, limit: number, onProgress?: (message: string) => void): Promise<ReadAttachmentResult> {
  if (!isLikelyText(file)) {
    return {
      content: "Only text-based files are enabled in this clean project version.",
      truncated: false,
      method: "unsupported",
      readable: false
    };
  }

  onProgress?.(`Reading ${file.name}...`);
  const raw = await file.text();
  const trimmed = trimContent(raw, limit);
  return { ...trimmed, method: "text", readable: trimmed.content.length > 0 };
}
