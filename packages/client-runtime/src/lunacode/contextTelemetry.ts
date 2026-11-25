import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2ProviderTurnTokenUsage,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2TurnItem,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { ContextWindowSnapshot } from "../state/contextWindow.ts";
import type { ThreadStructureVisibleTurnItem } from "../state/models.ts";

export interface LunaContextTurnSummary {
  readonly turnId: string;
  readonly runId: RunId | null;
  readonly turnNumber: number;
  readonly completedAtMs: number | null;
  readonly startedAtMs: number | null;
  readonly gapSincePreviousMs: number | null;
  readonly cachedTokens: number;
  readonly totalInputTokens: number;
  readonly hitRatePercent: number | null;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly tokensPerSecond: number | null;
}

export interface LunaCompositionSegment {
  readonly key: "tools" | "assistant" | "user" | "reasoning" | "attachments";
  readonly label: string;
  readonly estimatedTokens: number;
  readonly percent: number;
}

export interface LunaEstimatedCost {
  readonly known: boolean;
  readonly label: string;
  readonly inputPerM: number;
  readonly cachedInputPerM: number;
  readonly outputPerM: number;
  readonly minUsd: number;
  readonly maxUsd: number;
}

export interface LunaContextTelemetry {
  readonly model: string | null;
  readonly usedTokens: number;
  readonly maxTokens: number | null;
  readonly usedPercent: number | null;
  readonly remainingTokens: number | null;
  readonly autoCompactThreshold: number | null;
  readonly promptCacheExpiresAtMs: number | null;
  readonly promptCacheTtlMs: number | null;
  readonly latestCall: {
    readonly cachedTokens: number;
    readonly totalInputTokens: number;
    readonly hitRatePercent: number | null;
  };
  readonly sessionTotals: {
    readonly totalInputTokens: number;
    readonly totalCachedTokens: number;
    readonly totalOutputTokens: number;
    readonly totalReasoningTokens: number;
    readonly completedTurnCount: number;
    readonly hitRatePercent: number | null;
  };
  readonly estimatedApiCost: LunaEstimatedCost;
  readonly compactionSavings: {
    readonly count: number;
    readonly lastSavedTokens: number | null;
    readonly totalSavedTokens: number;
  };
  readonly recentTurns: ReadonlyArray<LunaContextTurnSummary>;
  readonly speedByRunId: ReadonlyMap<RunId, number>;
  readonly compositionBreakdown: ReadonlyArray<LunaCompositionSegment>;
}

export interface DeriveLunaContextTelemetryInput {
  readonly providerTurns: ReadonlyArray<
    Pick<
      OrchestrationV2ProviderTurn,
      | "id"
      | "providerThreadId"
      | "runAttemptId"
      | "ordinal"
      | "status"
      | "startedAt"
      | "completedAt"
      | "tokenUsage"
      | "turnTokenUsage"
      | "model"
    >
  >;
  readonly attempts?: ReadonlyArray<
    Pick<OrchestrationV2RunAttempt, "id" | "runId" | "providerTurnId">
  >;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "startedAt" | "completedAt">>;
  readonly visibleTurnItems: ReadonlyArray<
    ThreadStructureVisibleTurnItem | { readonly item: OrchestrationV2TurnItem }
  >;
  readonly messages?: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly text: string;
    readonly attachments?: ReadonlyArray<{
      readonly name?: string | undefined;
    }>;
  }>;
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly liveUsage: OrchestrationV2ProviderTurnTokenUsage | null;
  readonly model: string | null;
  readonly activeProviderThreadId: string | null | undefined;
}

interface ModelPriceSpec {
  readonly label: string;
  readonly match: (normalizedModel: string) => boolean;
  readonly inputPerM: number;
  readonly cachedInputPerM: number;
  readonly outputPerM: number;
}

const MODEL_PRICE_TABLE: ReadonlyArray<ModelPriceSpec> = [
  {
    label: "Claude Opus 4.x",
    match: (m) =>
      m.includes("opus") &&
      (m.includes("4-5") || m.includes("4.5") || m.includes("4-6") || m.includes("4.6")),
    inputPerM: 5,
    cachedInputPerM: 0.5,
    outputPerM: 25,
  },
  {
    label: "Claude Opus 4",
    match: (m) => m.includes("opus"),
    inputPerM: 15,
    cachedInputPerM: 1.5,
    outputPerM: 75,
  },
  {
    label: "Claude Sonnet",
    match: (m) => m.includes("sonnet"),
    inputPerM: 3,
    cachedInputPerM: 0.3,
    outputPerM: 15,
  },
  {
    label: "Claude Haiku 4.5",
    match: (m) => m.includes("haiku") && (m.includes("4-5") || m.includes("4.5")),
    inputPerM: 1,
    cachedInputPerM: 0.1,
    outputPerM: 5,
  },
  {
    label: "Claude Haiku",
    match: (m) => m.includes("haiku"),
    inputPerM: 0.8,
    cachedInputPerM: 0.08,
    outputPerM: 4,
  },
  {
    label: "GPT-5 / GPT-6 / Codex",
    match: (m) => m.includes("gpt-6") || m.includes("gpt-5") || m.includes("codex"),
    inputPerM: 2.5,
    cachedInputPerM: 0.25,
    outputPerM: 15,
  },
  {
    label: "OpenAI o3 / o4-mini",
    match: (m) => m.startsWith("o3") || m.startsWith("o4"),
    inputPerM: 1.1,
    cachedInputPerM: 0.275,
    outputPerM: 4.4,
  },
  {
    label: "Gemini Pro",
    match: (m) => m.includes("gemini") && m.includes("pro"),
    inputPerM: 1.25,
    cachedInputPerM: 0.31,
    outputPerM: 10,
  },
  {
    label: "Gemini Flash",
    match: (m) => m.includes("gemini") && m.includes("flash"),
    inputPerM: 0.3,
    cachedInputPerM: 0.075,
    outputPerM: 2.5,
  },
  {
    label: "DeepSeek",
    match: (m) => m.includes("deepseek"),
    inputPerM: 0.28,
    cachedInputPerM: 0.028,
    outputPerM: 0.42,
  },
];

function lookupModelPrice(model: string | null): ModelPriceSpec | null {
  if (!model) return null;
  const normalized = model.trim().toLowerCase();
  if (!normalized) return null;
  for (const spec of MODEL_PRICE_TABLE) {
    if (spec.match(normalized)) return spec;
  }
  return null;
}

function toEpochMs(value: DateTime.DateTime | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (DateTime.isDateTime(value)) {
    return DateTime.toEpochMillis(value);
  }
  return null;
}

function nonNeg(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function computeHitRate(cached: number, totalInput: number): number | null {
  if (totalInput <= 0) return null;
  return Math.max(0, Math.min(100, (cached / totalInput) * 100));
}

function itemTextLength(item: Record<string, unknown>, keys: ReadonlyArray<string>): number {
  let length = 0;
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string") length += value.length;
  }
  return length;
}

export function deriveLunaContextTelemetry(
  input: DeriveLunaContextTelemetryInput,
): LunaContextTelemetry {
  const usedTokens = Math.max(
    0,
    nonNeg(input.contextWindow?.usedTokens ?? input.liveUsage?.usedTokens),
  );
  const rawMax = input.contextWindow?.maxTokens ?? input.liveUsage?.maxTokens ?? null;
  const maxTokens = rawMax !== null && rawMax > 0 ? rawMax : null;
  const usedPercent =
    maxTokens !== null
      ? Math.max(0, Math.min(100, (usedTokens / maxTokens) * 100))
      : (input.contextWindow?.usedPercentage ?? null);
  const remainingTokens =
    maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;

  const promptCacheTtlMs = input.liveUsage?.promptCacheTtlMs ?? null;
  let promptCacheExpiresAtMs = toEpochMs(input.liveUsage?.promptCacheExpiresAt);
  if (promptCacheExpiresAtMs === null && promptCacheTtlMs !== null) {
    const updatedAtMs = toEpochMs(input.liveUsage?.updatedAt);
    if (updatedAtMs !== null) {
      promptCacheExpiresAtMs = updatedAtMs + promptCacheTtlMs;
    }
  }

  const runByAttemptId = new Map<string, RunId>();
  const runByTurnId = new Map<string, RunId>();
  for (const attempt of input.attempts ?? []) {
    runByAttemptId.set(attempt.id, attempt.runId);
    if (attempt.providerTurnId !== null) {
      runByTurnId.set(attempt.providerTurnId, attempt.runId);
    }
  }
  const runById = new Map(input.runs.map((run) => [run.id, run] as const));

  const matchingTurns =
    input.activeProviderThreadId != null
      ? input.providerTurns.filter((turn) => turn.providerThreadId === input.activeProviderThreadId)
      : input.providerTurns;
  const candidateTurns = matchingTurns.length > 0 ? matchingTurns : input.providerTurns;

  const sortedTurns = [...candidateTurns].sort((left, right) => {
    if (left.ordinal !== right.ordinal) return left.ordinal - right.ordinal;
    const leftAt = toEpochMs(left.startedAt) ?? toEpochMs(left.completedAt) ?? 0;
    const rightAt = toEpochMs(right.startedAt) ?? toEpochMs(right.completedAt) ?? 0;
    return leftAt - rightAt;
  });

  let totalInputTokens = 0;
  let totalCachedTokens = 0;
  let totalOutputTokens = 0;
  let totalReasoningTokens = 0;
  let completedTurnCount = 0;
  let previousCompletedAtMs: number | null = null;
  const speedByRunId = new Map<RunId, number>();
  const chronologicalTurns: Array<LunaContextTurnSummary> = [];

  for (const turn of sortedTurns) {
    const usage = turn.turnTokenUsage;
    const liveTurnUsage = turn.tokenUsage;
    const rawTurnInput = usage?.inputTokens ?? liveTurnUsage?.inputTokens ?? 0;
    const rawTurnCached = usage?.cachedInputTokens ?? liveTurnUsage?.cachedInputTokens ?? 0;
    const turnInput = Math.max(0, rawTurnInput, rawTurnCached);
    const turnCached = Math.min(turnInput, Math.max(0, rawTurnCached));
    const turnOutput = nonNeg(usage?.outputTokens ?? liveTurnUsage?.outputTokens);
    const turnReasoning = nonNeg(usage?.reasoningTokens ?? liveTurnUsage?.reasoningOutputTokens);

    if (turn.status === "completed") {
      completedTurnCount += 1;
    }

    const hasUsage = turnInput > 0 || turnOutput > 0 || turnCached > 0;
    const runId =
      (turn.runAttemptId !== null ? runByAttemptId.get(turn.runAttemptId) : undefined) ??
      runByTurnId.get(turn.id) ??
      null;
    const run = runId !== null ? runById.get(runId) : undefined;
    const startedAtMs = toEpochMs(turn.startedAt) ?? toEpochMs(run?.startedAt);
    const completedAtMs = toEpochMs(turn.completedAt) ?? toEpochMs(run?.completedAt);

    let tokensPerSecond: number | null = null;
    if (turnOutput > 0 && startedAtMs !== null && completedAtMs !== null) {
      const durationMs = completedAtMs - startedAtMs;
      if (durationMs >= 300) {
        tokensPerSecond = turnOutput / (durationMs / 1000);
        if (runId !== null) {
          speedByRunId.set(runId, tokensPerSecond);
        }
      }
    }

    if (hasUsage) {
      totalInputTokens += turnInput;
      totalCachedTokens += turnCached;
      totalOutputTokens += turnOutput;
      totalReasoningTokens += turnReasoning;

      const anchorMs = startedAtMs ?? completedAtMs;
      const gapSincePreviousMs =
        previousCompletedAtMs !== null && anchorMs !== null && anchorMs > previousCompletedAtMs
          ? anchorMs - previousCompletedAtMs
          : null;

      chronologicalTurns.push({
        turnId: turn.id,
        runId,
        turnNumber: chronologicalTurns.length + 1,
        completedAtMs,
        startedAtMs,
        gapSincePreviousMs,
        cachedTokens: turnCached,
        totalInputTokens: turnInput,
        hitRatePercent: computeHitRate(turnCached, turnInput),
        outputTokens: turnOutput,
        reasoningTokens: turnReasoning,
        tokensPerSecond,
      });
    }

    if (completedAtMs !== null) {
      previousCompletedAtMs = completedAtMs;
    }
  }

  const latestTurn = chronologicalTurns[chronologicalTurns.length - 1];
  const liveInput = nonNeg(input.liveUsage?.inputTokens ?? input.contextWindow?.inputTokens);
  const liveCachedRaw = nonNeg(
    input.liveUsage?.cachedInputTokens ?? input.contextWindow?.cachedInputTokens,
  );
  const latestTotalInput =
    liveInput > 0 || liveCachedRaw > 0
      ? Math.max(liveInput, liveCachedRaw)
      : (latestTurn?.totalInputTokens ?? 0);
  const latestCached =
    liveInput > 0 || liveCachedRaw > 0
      ? Math.min(latestTotalInput, liveCachedRaw)
      : (latestTurn?.cachedTokens ?? 0);

  if (totalInputTokens === 0 && latestTotalInput > 0) {
    totalInputTokens = latestTotalInput;
    totalCachedTokens = latestCached;
    totalOutputTokens = nonNeg(input.liveUsage?.outputTokens ?? input.contextWindow?.outputTokens);
    totalReasoningTokens = nonNeg(
      input.liveUsage?.reasoningOutputTokens ?? input.contextWindow?.reasoningOutputTokens,
    );
  }

  let latestTurnModel: string | null = null;
  for (let index = sortedTurns.length - 1; index >= 0; index -= 1) {
    const candidateModel = sortedTurns[index]?.model;
    if (typeof candidateModel === "string" && candidateModel.length > 0) {
      latestTurnModel = candidateModel;
      break;
    }
  }
  const effectiveModel = latestTurnModel ?? input.model;
  const priceSpec = lookupModelPrice(effectiveModel);
  const uncachedInput = Math.max(0, totalInputTokens - totalCachedTokens);
  const estimatedMinUsd = priceSpec
    ? (uncachedInput * priceSpec.inputPerM +
        totalCachedTokens * priceSpec.cachedInputPerM +
        totalOutputTokens * priceSpec.outputPerM) /
      1_000_000
    : 0;
  const estimatedMaxUsd = priceSpec
    ? ((uncachedInput * priceSpec.inputPerM * 1.25 +
        totalCachedTokens * priceSpec.cachedInputPerM +
        totalOutputTokens * priceSpec.outputPerM) /
        1_000_000) *
      1.15
    : 0;

  let compactionCount = 0;
  let lastSavedTokens: number | null = null;
  let totalSavedTokens = 0;

  let toolChars = 0;
  let assistantChars = 0;
  let userChars = 0;
  let reasoningChars = 0;
  let attachmentChars = 0;

  const hasMessages = (input.messages?.length ?? 0) > 0;
  for (const message of input.messages ?? []) {
    const len = message.text.length;
    if (message.role === "assistant") assistantChars += len;
    else if (message.role === "user") userChars += len;
    if (message.attachments && message.attachments.length > 0) {
      attachmentChars += message.attachments.length * 400;
    }
  }

  for (const { item } of input.visibleTurnItems) {
    const record = item as unknown as Record<string, unknown>;
    switch (item.type) {
      case "compaction": {
        if (item.status === "completed") {
          const before = item.beforeTokenCount;
          const after = item.afterTokenCount;
          if (typeof before === "number" && typeof after === "number" && before >= after) {
            const saved = before - after;
            compactionCount += 1;
            lastSavedTokens = saved;
            totalSavedTokens += saved;
          }
        }
        attachmentChars += itemTextLength(record, ["summary"]);
        break;
      }
      case "user_message":
        if (!hasMessages) {
          userChars += itemTextLength(record, ["text"]);
          if (Array.isArray(record.attachments) && record.attachments.length > 0) {
            attachmentChars += record.attachments.length * 400;
          }
        }
        if (record.context !== undefined) {
          attachmentChars += JSON.stringify(record.context).length;
        }
        break;
      case "assistant_message":
        if (!hasMessages) {
          assistantChars += itemTextLength(record, ["text"]);
        }
        break;
      case "reasoning":
        reasoningChars += itemTextLength(record, ["text"]);
        break;
      case "command_execution":
        toolChars += itemTextLength(record, ["input", "output"]);
        if (record.outputOmitted === true) toolChars += 1200;
        break;
      case "file_change":
        toolChars += itemTextLength(record, ["fileName", "diffStr", "oldStr", "newStr"]);
        if (Array.isArray(record.changes)) toolChars += JSON.stringify(record.changes).length;
        break;
      case "file_search":
      case "web_search":
        toolChars += itemTextLength(record, ["pattern"]);
        if (Array.isArray(record.patterns)) toolChars += JSON.stringify(record.patterns).length;
        if (Array.isArray(record.results)) toolChars += JSON.stringify(record.results).length;
        break;
      case "proposed_plan":
        assistantChars += itemTextLength(record, ["markdown"]);
        break;
      case "todo_list":
        assistantChars += itemTextLength(record, ["explanation"]);
        if (Array.isArray(record.steps)) assistantChars += JSON.stringify(record.steps).length;
        break;
      case "handoff":
        attachmentChars += itemTextLength(record, ["summary"]);
        break;
      default:
        toolChars += itemTextLength(record, ["message", "prompt", "reason"]);
        break;
    }
  }

  const rawSegments = [
    {
      key: "tools" as const,
      label: "工具调用与输出",
      tokens: Math.round(toolChars / 3.5),
    },
    {
      key: "assistant" as const,
      label: "助手回复",
      tokens: Math.round(assistantChars / 3.5),
    },
    {
      key: "user" as const,
      label: "用户输入",
      tokens: Math.round(userChars / 3.5),
    },
    {
      key: "reasoning" as const,
      label: "推理思考",
      tokens: reasoningChars > 0 ? Math.round(reasoningChars / 3.5) : totalReasoningTokens,
    },
    {
      key: "attachments" as const,
      label: "附件与上下文引用",
      tokens: Math.round(attachmentChars / 3.5),
    },
  ];
  const segmentTotal = rawSegments.reduce((sum, seg) => sum + seg.tokens, 0);
  const compositionBreakdown: LunaCompositionSegment[] = rawSegments.map((seg) => ({
    key: seg.key,
    label: seg.label,
    estimatedTokens: seg.tokens,
    percent: segmentTotal > 0 ? (seg.tokens / segmentTotal) * 100 : 0,
  }));

  return {
    model: effectiveModel,
    usedTokens,
    maxTokens,
    usedPercent,
    remainingTokens,
    autoCompactThreshold: input.contextWindow?.autoCompactThreshold ?? null,
    promptCacheExpiresAtMs,
    promptCacheTtlMs,
    latestCall: {
      cachedTokens: latestCached,
      totalInputTokens: latestTotalInput,
      hitRatePercent: computeHitRate(latestCached, latestTotalInput),
    },
    sessionTotals: {
      totalInputTokens,
      totalCachedTokens,
      totalOutputTokens,
      totalReasoningTokens,
      completedTurnCount,
      hitRatePercent: computeHitRate(totalCachedTokens, totalInputTokens),
    },
    estimatedApiCost: {
      known: priceSpec !== null,
      label: priceSpec?.label ?? "未知模型单价",
      inputPerM: priceSpec?.inputPerM ?? 0,
      cachedInputPerM: priceSpec?.cachedInputPerM ?? 0,
      outputPerM: priceSpec?.outputPerM ?? 0,
      minUsd: estimatedMinUsd,
      maxUsd: estimatedMaxUsd,
    },
    compactionSavings: {
      count: compactionCount,
      lastSavedTokens,
      totalSavedTokens,
    },
    recentTurns: [...chronologicalTurns].reverse(),
    speedByRunId,
    compositionBreakdown,
  };
}

export function formatTokenCompact(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined || !Number.isFinite(tokens)) return "0";
  const value = Math.max(0, tokens);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}K`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return String(Math.round(value));
}

export function formatPercent2(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${Math.max(0, Math.min(100, value)).toFixed(2)}%`;
}

export function formatDurationZh(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return "-";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours} 小时 ${remMinutes} 分` : `${hours} 小时`;
}

export function formatCountdownClock(remainingMs: number): string {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return "已过期";
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatUsdRange(cost: LunaEstimatedCost): string {
  if (!cost.known) return "暂无参考单价";
  const formatOne = (usd: number) =>
    usd < 0.01 && usd > 0 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
  if (Math.abs(cost.maxUsd - cost.minUsd) < 0.01) {
    return `≈ ${formatOne(cost.minUsd)}`;
  }
  return `≈ ${formatOne(cost.minUsd)} – ${formatOne(cost.maxUsd)}`;
}
