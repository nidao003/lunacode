// @effect-diagnostics globalFetch:off globalTimers:off globalDate:off - Lightweight user-triggered HTTP client for Web and React Native outside an Effect runtime.
import type { LunaOpenVikingConfig } from "./preferences.ts";

export interface OpenVikingMemoryHit {
  readonly id: string;
  readonly uri: string;
  readonly title: string;
  readonly snippet: string;
  readonly score: number;
}

export function buildOpenVikingHeaders(apiKey: string): Record<string, string> {
  const trimmed = apiKey.trim();
  return trimmed
    ? { "Content-Type": "application/json", "X-API-Key": trimmed }
    : { "Content-Type": "application/json" };
}

export function buildMemoryUri(title: string, nowMs = 0): string {
  const slug =
    title
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9\u4e00-\u9fff_-]+/g, "-")
      .replaceAll(/^-+|-+$/g, "")
      .slice(0, 48) || "note";
  const stamp = Math.max(0, Math.floor(nowMs));
  return `viking://user/memories/lunacode/${slug}-${stamp}.md`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickString(obj: Record<string, unknown>, keys: ReadonlyArray<string>): string {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "string" && val.trim().length > 0) {
      return val.trim();
    }
  }
  return "";
}

export function normalizeSearchResults(payload: unknown): ReadonlyArray<OpenVikingMemoryHit> {
  const root = asRecord(payload);
  const inner = asRecord(root?.result) ?? root;

  const candidates: unknown[] = [];
  if (Array.isArray(payload)) {
    candidates.push(...payload);
  } else if (inner) {
    for (const field of ["memories", "resources", "skills", "items", "results", "hits"]) {
      const list = inner[field];
      if (Array.isArray(list)) {
        candidates.push(...list);
      }
    }
  }

  const hits: OpenVikingMemoryHit[] = [];
  const seenUri = new Set<string>();

  candidates.forEach((raw, index) => {
    const row = asRecord(raw);
    if (!row) return;
    const uri = pickString(row, ["uri", "target_uri", "path", "id"]) || `memory-${index + 1}`;
    if (seenUri.has(uri)) return;
    seenUri.add(uri);

    const snippet = pickString(row, ["content", "overview", "abstract", "snippet", "text"]);
    if (!snippet) return;

    const title =
      pickString(row, ["title", "name"]) || uri.split("/").pop() || `记忆 #${index + 1}`;
    const rawScore = row.score;
    const score = typeof rawScore === "number" && Number.isFinite(rawScore) ? rawScore : 0;

    hits.push({
      id: `${uri}#${index}`,
      uri,
      title,
      snippet,
      score,
    });
  });

  return [...hits].sort((left, right) => right.score - left.score);
}

export function formatMemoryTailInjection(
  hits: ReadonlyArray<OpenVikingMemoryHit>,
  maxChars: number,
): string {
  if (hits.length === 0) return "";
  const cap = Math.max(120, Math.round(maxChars));
  const lines: string[] = ["### 历史相关记忆（来自 OpenViking，按需附加于消息尾部以保护前缀缓存）"];
  for (const hit of hits) {
    const single = `- [${hit.title}] (${hit.uri}): ${hit.snippet.replaceAll(/\s+/g, " ").trim()}`;
    lines.push(single);
  }
  const joined = lines.join("\n");
  if (joined.length <= cap) return joined;
  return `${joined.slice(0, Math.max(0, cap - 3)).trimEnd()}...`;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replaceAll(/\/+$/g, "");
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timer);
  }
}

function formatHttpError(status: number, bodyText: string): string {
  if (status === 401 || status === 403) {
    return "OpenViking 鉴权失败（401/403），请在 Settings -> Labs 中配置有效的 API Key。";
  }
  const detail = bodyText.trim().slice(0, 160);
  return detail ? `OpenViking 请求失败 (${status}): ${detail}` : `OpenViking 请求失败 (${status})`;
}

export async function checkOpenVikingHealth(
  config: LunaOpenVikingConfig,
): Promise<{ readonly ok: boolean; readonly detail: string }> {
  const base = normalizeBaseUrl(config.baseUrl);
  if (!base) {
    return { ok: false, detail: "请先填写 OpenViking 服务地址。" };
  }
  try {
    const res = await fetchWithTimeout(`${base}/health`, { method: "GET" }, 5000);
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, detail: formatHttpError(res.status, text) };
    }
    return { ok: true, detail: `连接正常 (${text.slice(0, 120) || "ok"})` };
  } catch (error) {
    return {
      ok: false,
      detail:
        error instanceof Error ? `无法连接 OpenViking: ${error.message}` : "无法连接 OpenViking",
    };
  }
}

export async function searchOpenVikingMemories(
  config: LunaOpenVikingConfig,
  query: string,
  limit = 6,
): Promise<ReadonlyArray<OpenVikingMemoryHit>> {
  const base = normalizeBaseUrl(config.baseUrl);
  if (!base) {
    throw new Error("请先配置 OpenViking 服务地址。");
  }
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [];
  }
  const res = await fetchWithTimeout(
    `${base}/api/v1/search/find`,
    {
      method: "POST",
      headers: buildOpenVikingHeaders(config.apiKey),
      body: JSON.stringify({
        query: trimmedQuery,
        limit,
        score_threshold: config.minScore,
        read_content: true,
      }),
    },
    8000,
  );
  if (!res.ok) {
    throw new Error(formatHttpError(res.status, await res.text()));
  }
  const json: unknown = await res.json();
  return normalizeSearchResults(json);
}

export async function saveOpenVikingMemory(
  config: LunaOpenVikingConfig,
  input: {
    readonly title: string;
    readonly content: string;
    readonly nowMs?: number | undefined;
  },
): Promise<{ readonly uri: string }> {
  const base = normalizeBaseUrl(config.baseUrl);
  if (!base) {
    throw new Error("请先配置 OpenViking 服务地址。");
  }
  const title = input.title.trim() || "LunaCode 会话结论";
  const body = input.content.trim();
  if (!body) {
    throw new Error("请输入需要沉淀的记忆正文。");
  }
  const uri = buildMemoryUri(title, input.nowMs ?? Date.now());
  const markdown = `# ${title}\n\n${body}\n`;

  const res = await fetchWithTimeout(
    `${base}/api/v1/content/write`,
    {
      method: "POST",
      headers: buildOpenVikingHeaders(config.apiKey),
      body: JSON.stringify({
        uri,
        content: markdown,
        mode: "replace",
        wait: false,
      }),
    },
    8000,
  );
  if (!res.ok) {
    throw new Error(formatHttpError(res.status, await res.text()));
  }
  return { uri };
}
