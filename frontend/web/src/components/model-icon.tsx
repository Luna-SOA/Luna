"use client";

import {
  AiStudio,
  Alibaba,
  AlibabaCloud,
  Anthropic,
  AzureAI,
  Baidu,
  BaiduCloud,
  Bailian,
  Bedrock,
  ByteDance,
  ChatGLM,
  Claude,
  Cloudflare,
  Codex,
  Cohere,
  CommandA,
  Dalle,
  Dbrx,
  DeepInfra,
  DeepSeek,
  Doubao,
  Fireworks,
  Gemini,
  Gemma,
  GithubCopilot,
  Google,
  Grok,
  Groq,
  HuggingFace,
  Hunyuan,
  Kimi,
  LlmApi,
  LmStudio,
  Meta,
  Mistral,
  Moonshot,
  NousResearch,
  Novita,
  Nvidia,
  Ollama,
  OpenAI,
  OpenRouter,
  OpenWebUI,
  Perplexity,
  Qwen,
  Replicate,
  SiliconCloud,
  Sora,
  Tencent,
  Together,
  VertexAI,
  Vllm,
  Volcengine,
  WorkersAI,
  XAI,
  Yi,
  ZAI,
  ZeroOne,
  type IconType
} from "@lobehub/icons";

interface IconEntry {
  Icon: IconType;
  label: string;
  aliases: readonly string[];
}

const fallback: IconEntry = { Icon: LlmApi, label: "OpenAI-compatible model", aliases: ["llmapi", "llm-api", "local", "localhost", "canopylabs", "allam", "docker"] };

const registry = [
  { Icon: Dalle, label: "DALL-E", aliases: ["dall-e", "dalle"] },
  { Icon: Sora, label: "Sora", aliases: ["sora"] },
  { Icon: Codex, label: "Codex", aliases: ["codex"] },
  { Icon: OpenAI, label: "OpenAI", aliases: ["openai", "chatgpt", "gpt", "gpt-oss", "o1", "o3", "o4"] },
  { Icon: Claude, label: "Claude", aliases: ["claude"] },
  { Icon: Anthropic, label: "Anthropic", aliases: ["anthropic"] },
  { Icon: Gemini, label: "Gemini", aliases: ["gemini"] },
  { Icon: Gemma, label: "Gemma", aliases: ["gemma"] },
  { Icon: VertexAI, label: "Vertex AI", aliases: ["vertex", "vertexai", "vertex-ai"] },
  { Icon: AiStudio, label: "AI Studio", aliases: ["aistudio", "ai-studio", "google-ai-studio"] },
  { Icon: Google, label: "Google", aliases: ["google"] },
  { Icon: Grok, label: "Grok", aliases: ["grok"] },
  { Icon: XAI, label: "xAI", aliases: ["xai", "x-ai"] },
  { Icon: Groq, label: "Groq", aliases: ["groq"] },
  { Icon: Qwen, label: "Qwen", aliases: ["qwen"] },
  { Icon: Bailian, label: "Bailian", aliases: ["dashscope", "bailian"] },
  { Icon: AlibabaCloud, label: "Alibaba Cloud", aliases: ["aliyun", "alibaba-cloud", "alibabacloud"] },
  { Icon: Alibaba, label: "Alibaba", aliases: ["alibaba"] },
  { Icon: DeepSeek, label: "DeepSeek", aliases: ["deepseek"] },
  { Icon: Mistral, label: "Mistral", aliases: ["mistral", "mixtral", "codestral"] },
  { Icon: Moonshot, label: "Moonshot AI", aliases: ["moonshot", "moonshotai"] },
  { Icon: Kimi, label: "Kimi", aliases: ["kimi"] },
  { Icon: Meta, label: "Meta", aliases: ["meta-llama", "llama", "codellama", "meta"] },
  { Icon: HuggingFace, label: "Hugging Face", aliases: ["huggingface", "hugging-face", "hf"] },
  { Icon: AzureAI, label: "Azure AI", aliases: ["azureai", "azure-ai", "azure"] },
  { Icon: WorkersAI, label: "Workers AI", aliases: ["workers-ai", "workersai", "cloudflare-ai"] },
  { Icon: Cloudflare, label: "Cloudflare", aliases: ["cloudflare"] },
  { Icon: Dbrx, label: "Databricks", aliases: ["databricks", "dbrx"] },
  { Icon: GithubCopilot, label: "GitHub Copilot", aliases: ["github-copilot", "copilot"] },
  { Icon: CommandA, label: "Command A", aliases: ["command-a", "command-r", "command-r-plus"] },
  { Icon: Bedrock, label: "Amazon Bedrock", aliases: ["bedrock", "amazon-bedrock"] },
  { Icon: NousResearch, label: "Nous Research", aliases: ["nous", "nousresearch", "nous-research"] },
  { Icon: BaiduCloud, label: "Baidu Cloud", aliases: ["baiducloud", "baidu-cloud"] },
  { Icon: Baidu, label: "Baidu", aliases: ["baidu", "ernie"] },
  { Icon: ChatGLM, label: "ChatGLM", aliases: ["zhipu", "chatglm", "glm", "glm-4", "glm-5"] },
  { Icon: ZAI, label: "Z.ai", aliases: ["zai", "z-ai", "z.ai"] },
  { Icon: Yi, label: "Yi", aliases: ["yi"] },
  { Icon: ZeroOne, label: "01.AI", aliases: ["zeroone", "zero-one", "01-ai", "01ai"] },
  { Icon: OpenRouter, label: "OpenRouter", aliases: ["openrouter", "open-router"] },
  { Icon: Ollama, label: "Ollama", aliases: ["ollama"] },
  { Icon: Vllm, label: "vLLM", aliases: ["vllm"] },
  { Icon: LmStudio, label: "LM Studio", aliases: ["lmstudio", "lm-studio"] },
  { Icon: OpenWebUI, label: "Open WebUI", aliases: ["openwebui", "open-webui"] },
  { Icon: Cohere, label: "Cohere", aliases: ["cohere"] },
  { Icon: Perplexity, label: "Perplexity", aliases: ["perplexity", "pplx"] },
  { Icon: Together, label: "Together AI", aliases: ["together", "together-ai"] },
  { Icon: Fireworks, label: "Fireworks", aliases: ["fireworks", "fireworks-ai"] },
  { Icon: Replicate, label: "Replicate", aliases: ["replicate"] },
  { Icon: DeepInfra, label: "DeepInfra", aliases: ["deepinfra", "deep-infra"] },
  { Icon: SiliconCloud, label: "SiliconCloud", aliases: ["siliconcloud", "silicon-cloud"] },
  { Icon: Novita, label: "Novita", aliases: ["novita", "novita-ai", "nova"] },
  { Icon: Nvidia, label: "NVIDIA", aliases: ["nvidia", "nemotron"] },
  { Icon: Tencent, label: "Tencent", aliases: ["tencent"] },
  { Icon: Hunyuan, label: "Hunyuan", aliases: ["hunyuan"] },
  { Icon: Doubao, label: "Doubao", aliases: ["doubao"] },
  { Icon: ByteDance, label: "ByteDance", aliases: ["bytedance", "byte-dance"] },
  { Icon: Volcengine, label: "Volcengine", aliases: ["volcengine", "volcano"] },
  fallback,
] satisfies IconEntry[];

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function tokens(value: string) {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function matchesAlias(value: string, alias: string) {
  const compactAlias = normalize(alias);
  if (!compactAlias) return false;
  if (compactAlias.length <= 3) return tokens(value).includes(compactAlias);
  return normalize(value).includes(compactAlias);
}

function findEntry(modelId: string): IconEntry {
  const id = modelId.trim();
  return registry.find((entry) => entry.aliases.some((alias) => matchesAlias(id, alias))) ?? fallback;
}

export function ModelIcon({ modelId, className = "h-4 w-4" }: { modelId: string; className?: string }) {
  const { Icon, label } = findEntry(modelId);

  return (
    <span className={`inline-flex items-center justify-center ${className}`} role="img" aria-label={label} title={label}>
      <Icon className="h-full w-full" aria-hidden="true" />
    </span>
  );
}
