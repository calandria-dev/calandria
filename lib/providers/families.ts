import type { ProviderType } from "./types";

export interface ModelPlacement {
  family: string;
  version: string;
  label: string;
  ctx: number;
  duplicate_of: string | null;
  chat: boolean;
}

interface FamilySpec {
  id: string;
  label: string;
  vendor: string;
  re: RegExp;
}

const FAMILIES: FamilySpec[] = [
  { id: "fable", label: "Fable", vendor: "anthropic", re: /^(?:claude-)?fable(?:-|$)/i },
  { id: "opus", label: "Opus", vendor: "anthropic", re: /^(?:claude-)?opus(?:-|$)/i },
  { id: "sonnet", label: "Sonnet", vendor: "anthropic", re: /^(?:claude-)?sonnet(?:-|$)/i },
  { id: "haiku", label: "Haiku", vendor: "anthropic", re: /^(?:claude-)?haiku(?:-|$)/i },
  { id: "gpt", label: "GPT", vendor: "openai", re: /^gpt(?:-|$)/i },
  { id: "gemini", label: "Gemini", vendor: "google", re: /^gemini(?:-|$)/i },
  { id: "qwen", label: "Qwen", vendor: "open", re: /^qwen(?:-|\d|$)/i },
  { id: "deepseek", label: "DeepSeek", vendor: "open", re: /^deepseek(?:-|$)/i },
  { id: "glm", label: "GLM", vendor: "open", re: /^(?:glm|chatglm)(?:-|\d|$)/i },
  { id: "kimi", label: "Kimi", vendor: "open", re: /^(?:kimi|moonshot)(?:-|$)/i },
  { id: "gemma", label: "Gemma", vendor: "open", re: /^gemma(?:-|\d|$)/i },
  { id: "llama", label: "Llama", vendor: "open", re: /^(?:llama|meta-llama)(?:-|\d|$)/i },
  { id: "mistral", label: "Mistral", vendor: "open", re: /^mistral(?:-|\d|$)/i },
  { id: "devstral", label: "Devstral", vendor: "open", re: /^devstral(?:-|\d|$)/i },
];

const GATEWAY_PREFIX = /^(?:anthropic|openai|together|moonshot|zai)\//i;
const DATED = /-(\d{8})(?=(?:\[1m\])?$)/i;
const SIZE = /:(\d+(?:\.\d+)?[bBmMkK])$/;
const NON_CHAT = /(?:embedding|embed|audio|image|moderation|rerank|whisper|tts|speech|vision-embed|dall-e|imagen|flux)/i;

function title(s: string): string {
  return s
    .split(/[-_:]+/)
    .filter(Boolean)
    .map((x) =>
      /^\d+(?:\.\d+)?[bmk]$/i.test(x) || /^(?:oss|glm|gpt)$/i.test(x)
        ? x.toUpperCase()
        : x[0].toUpperCase() + x.slice(1),
    )
    .join(" ");
}

function contextFor(family: string, id: string): number {
  if (family === "fable" || /\[1m\]/i.test(id)) return 1_000_000;
  if ((family === "opus" || family === "sonnet") && /(?:opus|sonnet)-5(?:-|$)/i.test(id)) return 1_000_000;
  if (family === "llama" && /llama-?4(?:-|$)/i.test(id)) return 1_000_000;
  if (family === "qwen" || family === "kimi" || family === "llama" || family === "mistral" || family === "devstral") return 256_000;
  if (family === "deepseek") return /deepseek-r2(?:-|:|$)/i.test(id) ? 64_000 : 128_000;
  if (family === "gemma") return 128_000;
  if (family === "gemini") return 1_000_000;
  if (family === "gpt") return 272_000;
  return 200_000;
}

/** Place a provider model in the stable family/version vocabulary used by the picker. */
export function placeModel(id: string, providerType: ProviderType): ModelPlacement {
  const raw = String(id);
  const normalized = raw.replace(GATEWAY_PREFIX, "");
  const dated = normalized.match(DATED);
  const undated = dated ? normalized.replace(DATED, "") : normalized;
  const candidate = undated.includes("/") ? undated.slice(undated.lastIndexOf("/") + 1) : undated;
  const isAlias = providerType === "anthropic" && /^(opus|sonnet|fable|haiku|opusplan)(?:\[1m\])?$/i.test(candidate);
  const aliasFamily = isAlias ? (candidate.replace(/\[1m\]$/i, "") === "opusplan" ? "opus" : candidate.replace(/\[1m\]$/i, "").toLowerCase()) : null;
  const spec = aliasFamily ? FAMILIES.find((f) => f.id === aliasFamily)! : FAMILIES.find((f) => f.re.test(candidate));
  const chat = !NON_CHAT.test(undated);
  if (!spec) {
    return { family: "other", version: raw, label: raw, ctx: 0, duplicate_of: null, chat };
  }
  const oneM = /\[1m\]/i.test(normalized);
  let version: string;
  let label: string;
  if (isAlias) {
    version = oneM ? "latest-1m" : "latest";
    label = `${spec.label} (latest${oneM ? ", 1M" : ""})`;
  } else {
    let body = candidate.replace(/\[1m\]$/i, "");
    if (/^claude-/i.test(body)) body = body.slice(7);
    const size = body.match(SIZE)?.[1];
    body = body.replace(SIZE, "");
    // Release numbers use dots in the family vocabulary (opus-4-8), while
    // product qualifiers retain their hyphens (qwen3-coder-30b).
    const versionBody = body.replace(/(\d+)-(\d+)(?=-|$)/g, "$1.$2");
    version = versionBody + (size ? `-${size.toLowerCase()}` : "") + (oneM ? "-1m" : "");
    const labelBody = spec.id === "qwen" && /^qwen\d/i.test(body)
      ? body
      : versionBody.replace(new RegExp(`^${spec.id}-?`, "i"), "");
    const display = spec.id === "qwen" && /^qwen\d/i.test(body)
      ? title(labelBody)
      : spec.id === "gpt" && labelBody
        ? `${spec.label}-${title(labelBody)}`
        : `${spec.label}${labelBody ? ` ${title(labelBody)}` : ""}`;
    label = `${display}${size ? ` ${size.toUpperCase()}` : ""}${oneM ? " (1M)" : ""}`.trim();
    if (!label || label === spec.label) label = title(undated);
  }
  return {
    family: spec.id,
    version,
    label,
    ctx: contextFor(spec.id, normalized),
    // Keep the source spelling in the duplicate pointer. This lets the
    // provider modal identify the exact gateway row that owns the canonical
    // model, while placement itself still uses the normalized id.
    duplicate_of: dated ? raw.replace(/-\d{8}(?=(?:\[1m\])?$)/i, "") : null,
    chat,
  };
}

export const modelFamilies = FAMILIES.map(({ re: _, ...family }) => family);
