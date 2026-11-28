import { describe, expect, it } from "@effect/vitest";
import type { WorkflowQuestion, WorkflowRun, WorkflowStep } from "@t3tools/contracts";

import {
  buildChatEditPrompt,
  buildLiveRunGraphOverlay,
  computeFlowDryRunClient,
  computeFlowLayout,
  createStarterFlowSpec,
  nextFlowVersionTarget,
  parseFlowSpecSafe,
  validateFlowClient,
} from "./workflowFlow.logic.ts";

describe("workflowFlow.logic", () => {
  it("starter templates validate with zero errors", () => {
    for (const template of ["parallel-review", "human-gate", "single-agent"] as const) {
      const spec = createStarterFlowSpec({
        name: `demo-${template}`,
        template,
        project: "proj-1",
      });
      const issues = validateFlowClient(spec);
      expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    }
  });

  it("increments version filename cleanly on createNewVersion", () => {
    const spec = createStarterFlowSpec({ name: "bugfix", project: "proj-1" });
    const v2 = nextFlowVersionTarget("bugfix.flow.json", spec);
    expect(v2.fileName).toBe("bugfix.v2.flow.json");
    expect(v2.spec.version).toBe(2);

    const v3 = nextFlowVersionTarget(v2.fileName, v2.spec);
    expect(v3.fileName).toBe("bugfix.v3.flow.json");
    expect(v3.spec.version).toBe(3);
  });

  it("rejects parallel non-worktree write conflicts on the same project", () => {
    const spec = createStarterFlowSpec({
      name: "parallel-conflict",
      template: "parallel-review",
      project: "proj-1",
    });
    const modified = {
      ...spec,
      nodes: spec.nodes.map((node) =>
        node.id === "implement" || node.id === "write_tests"
          ? { ...node, workspaceOverride: "root" as const }
          : node,
      ),
    };
    const report = computeFlowDryRunClient(modified);
    expect(report.valid).toBe(false);
    expect(report.parallelWriteRisks.length).toBeGreaterThan(0);
    expect(report.issues.some((i) => i.code === "parallel_root_write_conflict")).toBe(true);
  });

  it("computes layered DAG coordinates and loop back-edge SVG paths", () => {
    const spec = createStarterFlowSpec({
      name: "layout-demo",
      template: "parallel-review",
      project: "proj-1",
    });
    const layout = computeFlowLayout(spec);
    expect(layout.layers).toHaveLength(4);
    expect(layout.layers[0]?.parallel).toBe(true);
    expect(layout.nodeById.implement?.x).toBe(layout.nodeById.write_tests?.x);
    expect(layout.nodeById.implement?.y).not.toBe(layout.nodeById.write_tests?.y);
    expect(layout.edges.some((edge) => edge.isLoop)).toBe(true);
    expect(layout.width).toBeGreaterThan(600);
    expect(layout.height).toBeGreaterThan(220);
  });

  it("parses JSON with syntax line detection and builds chat edit prompts", () => {
    const broken = parseFlowSpecSafe('{\n  "schemaVersion": 1,\n  broken\n}');
    expect(broken.ok).toBe(false);

    const spec = createStarterFlowSpec({ name: "my-flow", project: "proj-1" });
    const prompt = buildChatEditPrompt("my-flow.flow.json", spec, "增加并发安全检查");
    expect(prompt).toContain("t3_flow_read");
    expect(prompt).toContain("t3_flow_save");
    expect(prompt).toContain("增加并发安全检查");
  });

  it("aggregates #N loop visits, @circuit-breaker, pending questions, and fallback steps", () => {
    const spec = createStarterFlowSpec({
      name: "runtime-demo",
      template: "parallel-review",
      project: "proj-1",
    });
    const run: WorkflowRun = {
      runId: "run-1",
      workflow: "runtime-demo",
      version: 1,
      title: "Fix issue",
      status: "waiting",
      detail: "approve_ship",
      result: null,
      pauses: 0,
      retired: false,
      resumesAt: null,
      parentRunId: null,
      parentStep: null,
      startedAt: "2026-11-28T00:00:00.000Z",
      updatedAt: "2026-11-28T00:00:15.000Z",
      endedAt: null,
      tags: [],
    };
    const steps: ReadonlyArray<WorkflowStep> = [
      {
        name: "implement",
        kind: "agent",
        status: "completed",
        attempts: 1,
        detail: null,
        threadId: "thread-impl-1",
        environmentId: null,
        result: { summary: "round 1" },
        said: "impl 1",
        startedAt: "2026-11-28T00:00:01.000Z",
        endedAt: "2026-11-28T00:00:05.000Z",
      },
      {
        name: "write_tests",
        kind: "agent",
        status: "completed",
        attempts: 1,
        detail: null,
        threadId: "thread-test-1",
        environmentId: null,
        result: { checks: "ok" },
        said: null,
        startedAt: "2026-11-28T00:00:01.000Z",
        endedAt: "2026-11-28T00:00:06.000Z",
      },
      {
        name: "review",
        kind: "agent",
        status: "completed",
        attempts: 1,
        detail: null,
        threadId: "thread-rev-1",
        environmentId: null,
        result: { approved: false },
        said: "needs fix",
        startedAt: "2026-11-28T00:00:07.000Z",
        endedAt: "2026-11-28T00:00:08.000Z",
      },
      {
        name: "implement#2",
        kind: "agent",
        status: "completed",
        attempts: 1,
        detail: null,
        threadId: "thread-impl-2",
        environmentId: null,
        result: { summary: "round 2" },
        said: "fixed",
        startedAt: "2026-11-28T00:00:09.000Z",
        endedAt: "2026-11-28T00:00:12.000Z",
      },
      {
        name: "@circuit-breaker#2",
        kind: "ask",
        status: "completed",
        attempts: 1,
        detail: null,
        threadId: null,
        environmentId: null,
        result: { choice: "放行一次" },
        said: null,
        startedAt: "2026-11-28T00:00:13.000Z",
        endedAt: "2026-11-28T00:00:14.000Z",
      },
      {
        name: "approve_ship",
        kind: "ask",
        status: "running",
        attempts: 1,
        detail: null,
        threadId: null,
        environmentId: null,
        result: null,
        said: null,
        startedAt: "2026-11-28T00:00:15.000Z",
        endedAt: null,
      },
    ];
    const questions: ReadonlyArray<WorkflowQuestion> = [
      {
        runId: "run-1",
        name: "approve_ship",
        request: { title: "Ship?", choices: [{ value: "批准发布" }] },
        askedAt: "2026-11-28T00:00:15.000Z",
        thread: { threadId: "thread-impl-2", environmentId: null },
      },
    ];

    const overlay = buildLiveRunGraphOverlay(spec, run, steps, questions);
    expect(overlay.totalLoopHops).toBe(1);
    expect(overlay.circuitBreakerCount).toBe(1);
    expect(overlay.nodeStates.implement?.visitCount).toBe(2);
    expect(overlay.nodeStates.implement?.threadId).toBe("thread-impl-2");
    expect(overlay.nodeStates.approve_ship?.status).toBe("waiting");
    expect(overlay.nodeStates.approve_ship?.pendingQuestion?.name).toBe("approve_ship");
    expect(overlay.crew).toHaveLength(3);

    // Also verifies fallback graph generation for TS workflows when spec is null
    const fallback = buildLiveRunGraphOverlay(null, run, steps, questions);
    expect(fallback.fallbackSpec?.nodes.length).toBeGreaterThanOrEqual(4);
    expect(fallback.crew.length).toBe(3);
  });
});
