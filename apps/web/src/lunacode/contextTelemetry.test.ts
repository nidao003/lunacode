import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";

import {
  deriveLunaContextTelemetry,
  formatCountdownClock,
  formatDurationZh,
  formatTokenCompact,
  formatUsdRange,
} from "./contextTelemetry.ts";

const PTHREAD_ID = "pthread:1" as never;
const NODE_ID = "node:1" as never;
const MSG_ID = "msg:1" as never;

describe("deriveLunaContextTelemetry", () => {
  it("computes cache hit rates, turn gaps, speedByRunId, compaction savings, and API cost", () => {
    const run1 = RunId.make("run:1");
    const run2 = RunId.make("run:2");
    const attempt1 = RunAttemptId.make("attempt:1");
    const attempt2 = RunAttemptId.make("attempt:2");

    const telemetry = deriveLunaContextTelemetry({
      model: "gpt-6.2-astra",
      activeProviderThreadId: PTHREAD_ID,
      contextWindow: {
        usedTokens: 85_300,
        totalProcessedTokens: null,
        maxTokens: 258_000,
        remainingTokens: 172_700,
        usedPercentage: 33.06,
        remainingPercentage: 66.94,
        inputTokens: 84_700,
        cachedInputTokens: 84_500,
        outputTokens: 600,
        reasoningOutputTokens: 120,
        lastUsedTokens: null,
        lastInputTokens: null,
        lastCachedInputTokens: null,
        lastOutputTokens: null,
        lastReasoningOutputTokens: null,
        toolUses: null,
        durationMs: null,
        compactsAutomatically: true,
        autoCompactThreshold: 220_000,
        cost: null,
        updatedAt: "2026-11-21T10:48:44.000Z",
      },
      liveUsage: {
        usedTokens: 85_300,
        maxTokens: 258_000,
        inputTokens: 84_700,
        cachedInputTokens: 84_500,
        outputTokens: 600,
        reasoningOutputTokens: 120,
        promptCacheTtlMs: 300_000,
        updatedAt: "2026-11-21T10:48:44.000Z",
      },
      attempts: [
        {
          id: attempt1,
          runId: run1,
          providerTurnId: ProviderTurnId.make("turn:1"),
        },
        {
          id: attempt2,
          runId: run2,
          providerTurnId: ProviderTurnId.make("turn:2"),
        },
      ],
      runs: [
        {
          id: run1,
          startedAt: "2026-11-21T10:22:00.000Z" as never,
          completedAt: "2026-11-21T10:22:24.000Z" as never,
        },
        {
          id: run2,
          startedAt: "2026-11-21T10:26:22.000Z" as never,
          completedAt: "2026-11-21T10:26:38.000Z" as never,
        },
      ],
      providerTurns: [
        {
          id: ProviderTurnId.make("turn:1"),
          providerThreadId: PTHREAD_ID,
          runAttemptId: attempt1,
          ordinal: 1,
          status: "completed",
          startedAt: "2026-11-21T10:22:00.000Z" as never,
          completedAt: "2026-11-21T10:22:24.000Z" as never,
          model: "gpt-6.2-astra",
          turnTokenUsage: {
            usageStatus: "complete",
            usageScope: "main_agent",
            inputTokens: 200_000,
            cachedInputTokens: 170_000,
            outputTokens: 480,
            reasoningTokens: 100,
            hasSubagents: false,
          },
        },
        {
          id: ProviderTurnId.make("turn:2"),
          providerThreadId: PTHREAD_ID,
          runAttemptId: attempt2,
          ordinal: 2,
          status: "completed",
          startedAt: "2026-11-21T10:26:22.000Z" as never,
          completedAt: "2026-11-21T10:26:38.000Z" as never,
          model: "gpt-6.2-astra",
          turnTokenUsage: {
            usageStatus: "complete",
            usageScope: "main_agent",
            inputTokens: 818_000,
            cachedInputTokens: 809_000,
            outputTokens: 320,
            reasoningTokens: 80,
            hasSubagents: false,
          },
        },
      ],
      messages: [
        { id: "m1", role: "user", text: "请分析上下文结构并给出修复方案" },
        {
          id: "m2",
          role: "assistant",
          text: "我已经定位了原因，详细修改如下...",
        },
      ],
      visibleTurnItems: [
        {
          item: {
            id: "item:cmd" as never,
            threadId: ThreadId.make("thread:1"),
            runId: run1,
            nodeId: NODE_ID,
            providerThreadId: PTHREAD_ID,
            providerTurnId: ProviderTurnId.make("turn:1"),
            nativeItemRef: null,
            parentItemId: null,
            title: null,
            ordinal: 1,
            status: "completed",
            startedAt: "2026-11-21T10:22:01.000Z" as never,
            completedAt: "2026-11-21T10:22:05.000Z" as never,
            updatedAt: "2026-11-21T10:22:05.000Z" as never,
            type: "command_execution",
            input: "git status",
            output: "On branch lunacode\nnothing to commit",
          },
        },
        {
          item: {
            id: "item:cmp" as never,
            threadId: ThreadId.make("thread:1"),
            runId: run1,
            nodeId: NODE_ID,
            providerThreadId: PTHREAD_ID,
            providerTurnId: ProviderTurnId.make("turn:1"),
            nativeItemRef: null,
            parentItemId: null,
            title: null,
            ordinal: 2,
            status: "completed",
            startedAt: "2026-11-21T10:22:10.000Z" as never,
            completedAt: "2026-11-21T10:22:12.000Z" as never,
            updatedAt: "2026-11-21T10:22:12.000Z" as never,
            type: "compaction",
            driver: "codex" as never,
            beforeTokenCount: 140_000,
            afterTokenCount: 45_000,
          },
        },
      ],
    });

    assert.equal(telemetry.usedTokens, 85_300);
    assert.equal(telemetry.maxTokens, 258_000);
    assert.closeTo(telemetry.latestCall.hitRatePercent ?? 0, (84_500 / 84_700) * 100, 0.01);
    assert.equal(telemetry.sessionTotals.totalInputTokens, 1_018_000);
    assert.equal(telemetry.sessionTotals.totalCachedTokens, 979_000);
    assert.equal(telemetry.sessionTotals.totalOutputTokens, 800);
    assert.equal(telemetry.sessionTotals.completedTurnCount, 2);
    assert.equal(
      telemetry.promptCacheExpiresAtMs,
      Date.parse("2026-11-21T10:48:44.000Z") + 300_000,
    );
    assert.equal(telemetry.compactionSavings.count, 1);
    assert.equal(telemetry.compactionSavings.lastSavedTokens, 95_000);
    assert.equal(telemetry.compactionSavings.totalSavedTokens, 95_000);

    // Recent turns sorted newest first
    assert.equal(telemetry.recentTurns.length, 2);
    assert.equal(telemetry.recentTurns[0]?.turnNumber, 2);
    assert.equal(telemetry.recentTurns[0]?.gapSincePreviousMs, 238_000);
    assert.closeTo(telemetry.speedByRunId.get(run1) ?? 0, 20, 0.01);
    assert.closeTo(telemetry.speedByRunId.get(run2) ?? 0, 20, 0.01);

    assert.isTrue(telemetry.estimatedApiCost.known);
    assert.isAbove(telemetry.estimatedApiCost.minUsd, 0);
    assert.isAbove(telemetry.estimatedApiCost.maxUsd, telemetry.estimatedApiCost.minUsd);

    const totalBreakdownPct = telemetry.compositionBreakdown.reduce((s, x) => s + x.percent, 0);
    assert.closeTo(totalBreakdownPct, 100, 0.1);

    // Keep unused IDs checked
    void ProviderInstanceId;
    void MSG_ID;
  });

  it("handles zero-token and unknown-model sessions safely", () => {
    const telemetry = deriveLunaContextTelemetry({
      model: "custom-local-test-model",
      activeProviderThreadId: null,
      runs: [],
      providerTurns: [],
      visibleTurnItems: [],
      contextWindow: null,
      liveUsage: null,
    });

    assert.equal(telemetry.usedTokens, 0);
    assert.isNull(telemetry.maxTokens);
    assert.isNull(telemetry.latestCall.hitRatePercent);
    assert.isNull(telemetry.sessionTotals.hitRatePercent);
    assert.isFalse(telemetry.estimatedApiCost.known);
    assert.equal(formatUsdRange(telemetry.estimatedApiCost), "暂无参考单价");
    assert.equal(telemetry.recentTurns.length, 0);
    assert.equal(telemetry.speedByRunId.size, 0);
  });

  it("formats compact tokens, durations, and countdowns cleanly", () => {
    assert.equal(formatTokenCompact(85_300), "85.3K");
    assert.equal(formatTokenCompact(3_840_000), "3.84M");
    assert.equal(formatDurationZh(238_000), "3 分 58 秒");
    assert.equal(formatCountdownClock(125_000), "2:05");
    assert.equal(formatCountdownClock(0), "已过期");
  });
});
