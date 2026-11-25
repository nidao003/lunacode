import { NodeId, PlanId, ProviderTurnId, RunId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { buildDeterministicHandoff } from "./handoffBuilder";

describe("buildDeterministicHandoff", () => {
  it("extracts goal, deduped files, failed commands, plan progress, and latest conclusion", () => {
    const result = buildDeterministicHandoff({
      threadTitle: "多账号隔离与上下文优化",
      branch: "lunacode",
      model: "claude-sonnet-4-6",
      messages: [
        {
          id: "m1",
          role: "user",
          text: "请实现合规的本地多账号隔离和缓存统计",
        },
        { id: "m2", role: "assistant", text: "已完成第一阶段代码" },
        { id: "m3", role: "user", text: "/compact" },
        { id: "m4", role: "user", text: "下一步请补齐手动作业与单元测试" },
        {
          id: "m5",
          role: "assistant",
          text: "最终验证全部通过，详情见 handoffBuilder.ts。",
        },
      ],
      visibleTurnItems: [
        {
          item: {
            id: "i1" as never,
            threadId: ThreadId.make("t1"),
            runId: RunId.make("r1"),
            nodeId: NodeId.make("n1"),
            providerThreadId: null,
            providerTurnId: ProviderTurnId.make("pt1"),
            nativeItemRef: null,
            parentItemId: null,
            title: null,
            ordinal: 1,
            status: "completed",
            startedAt: "2026-11-21T10:00:00.000Z" as never,
            completedAt: "2026-11-21T10:00:02.000Z" as never,
            updatedAt: "2026-11-21T10:00:02.000Z" as never,
            type: "file_change",
            fileName: "apps/web/src/lunacode/contextTelemetry.ts" as never,
          },
        },
        {
          item: {
            id: "i2" as never,
            threadId: ThreadId.make("t1"),
            runId: RunId.make("r1"),
            nodeId: NodeId.make("n1"),
            providerThreadId: null,
            providerTurnId: ProviderTurnId.make("pt1"),
            nativeItemRef: null,
            parentItemId: null,
            title: null,
            ordinal: 2,
            status: "completed",
            startedAt: "2026-11-21T10:00:02.000Z" as never,
            completedAt: "2026-11-21T10:00:03.000Z" as never,
            updatedAt: "2026-11-21T10:00:03.000Z" as never,
            type: "file_change",
            fileName: "apps/web/src/lunacode/contextTelemetry.ts" as never,
            changes: [
              {
                path: "apps/desktop/src/lunacode/branding.ts" as never,
                operation: "update",
              },
            ],
          },
        },
        {
          item: {
            id: "i3" as never,
            threadId: ThreadId.make("t1"),
            runId: RunId.make("r1"),
            nodeId: NodeId.make("n1"),
            providerThreadId: null,
            providerTurnId: ProviderTurnId.make("pt1"),
            nativeItemRef: null,
            parentItemId: null,
            title: null,
            ordinal: 3,
            status: "failed",
            startedAt: "2026-11-21T10:00:04.000Z" as never,
            completedAt: "2026-11-21T10:00:05.000Z" as never,
            updatedAt: "2026-11-21T10:00:05.000Z" as never,
            type: "command_execution",
            input: "vp run typecheck",
            exitCode: 2,
            outputIndicatesFailure: true,
          },
        },
      ],
      plans: [
        {
          id: PlanId.make("p1"),
          threadId: ThreadId.make("t1"),
          runId: RunId.make("r1"),
          nodeId: NodeId.make("n1"),
          status: "active",
          kind: "todo_list",
          steps: [
            {
              id: "s1" as never,
              text: "实现桌面打包隔离",
              status: "completed",
            },
            {
              id: "s2" as never,
              text: "补齐结构化接力测试",
              status: "running",
            },
          ],
        },
      ],
    });

    assert.include(result.markdown, "多账号隔离与上下文优化");
    assert.include(result.markdown, "lunacode");
    assert.include(result.markdown, "初始目标：请实现合规的本地多账号隔离和缓存统计");
    assert.include(result.markdown, "最新诉求：下一步请补齐手动作业与单元测试");
    assert.notInclude(result.markdown, "/compact");
    assert.equal(result.stats.filesCount, 2);
    assert.equal(result.stats.completedSteps, 1);
    assert.equal(result.stats.pendingSteps, 1);
    assert.include(result.markdown, "[失败 exit 2] `vp run typecheck`");
    assert.include(result.markdown, "handoffBuilder.ts");
  });

  it("handles empty threads and strictly respects maxChars", () => {
    const empty = buildDeterministicHandoff({
      messages: [],
      visibleTurnItems: [],
    });
    assert.include(empty.markdown, "暂无用户输入记录");
    assert.include(empty.markdown, "暂无记录");

    const capped = buildDeterministicHandoff({
      threadTitle: "长内容截断校验",
      messages: [
        { id: "m1", role: "user", text: "A".repeat(1500) },
        { id: "m2", role: "assistant", text: "B".repeat(1500) },
      ],
      visibleTurnItems: [],
      maxChars: 280,
    });
    assert.isAtMost(capped.charCount, 280);
    assert.include(capped.markdown, "请基于以上上下文继续推进");
  });
});
