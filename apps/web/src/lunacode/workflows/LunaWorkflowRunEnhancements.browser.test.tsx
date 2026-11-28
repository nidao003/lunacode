import {
  createStarterFlowSpec,
  formatFlowSpecJson,
} from "@t3tools/client-runtime/lunacode/workflow-flow";
import type { WorkflowRunNode } from "@t3tools/client-runtime/workflows";
import {
  EnvironmentId,
  type WorkflowQuestion,
  type WorkflowRun,
  type WorkflowStep,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { LunaWorkflowRunEnhancements } from "./LunaWorkflowRunEnhancements";

const ENV_ID = EnvironmentId.make("env-1");

const hoisted = vi.hoisted(() => ({
  answers: [] as Array<unknown>,
  files: [] as ReadonlyArray<{ readonly name: string; readonly source: string }>,
}));

vi.mock(import("../../state/query"), (() => ({
  useEnvironmentQuery: () => ({
    data: {
      directory: "/tmp/workflows",
      single: false,
      revision: 1,
      problem: null,
      problems: [],
      files: hoisted.files,
    },
    error: null,
  }),
})) as never);

vi.mock(import("../../state/use-atom-command"), (() => ({
  useAtomCommand: () => async (payload: unknown) => {
    hoisted.answers.push(payload);
    return { _tag: "Success", value: undefined } as never;
  },
})) as never);

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const permitted = Atom.make(true);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      answerWorkflowQuestion: {
        ...actual.serverEnvironment.answerWorkflowQuestion,
        permissionAtom: () => permitted,
      },
    },
  };
});

describe("LunaWorkflowRunEnhancements", () => {
  it("switches between timeline, live DAG graph with #2 loop badge, and Live Crew Steer + inline approval", async () => {
    hoisted.answers = [];
    const spec = createStarterFlowSpec({
      name: "demo-flow",
      template: "parallel-review",
      project: "project-1",
    });
    hoisted.files = [{ name: "demo.flow.json", source: formatFlowSpecJson(spec) }];

    const run: WorkflowRun = {
      runId: "run-1",
      workflow: "demo-flow",
      version: 1,
      title: "Fix critical bug",
      status: "waiting",
      detail: "approve_ship",
      result: null,
      pauses: 0,
      retired: false,
      resumesAt: null,
      parentRunId: null,
      parentStep: null,
      startedAt: "2026-11-28T00:00:00.000Z",
      updatedAt: "2026-11-28T00:01:00.000Z",
      endedAt: null,
    };

    const question: WorkflowQuestion = {
      runId: "run-1",
      name: "approve_ship",
      request: {
        title: "是否确认合入发布？",
        choices: ["批准发布", "继续打磨"],
        choiceDetails: [{ value: "批准发布" }, { value: "继续打磨", requireReason: true }],
      },
      askedAt: "2026-11-28T00:00:30.000Z",
      thread: { threadId: "thread-impl-2", environmentId: null },
    };

    const node: WorkflowRunNode = {
      run,
      questions: [question],
      children: [],
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
        endedAt: "2026-11-28T00:00:10.000Z",
      },
      {
        name: "implement#2",
        kind: "agent",
        status: "completed",
        attempts: 1,
        detail: null,
        threadId: "thread-impl-2",
        environmentId: null,
        result: { summary: "round 2 fix" },
        said: "impl 2 fixed",
        startedAt: "2026-11-28T00:00:15.000Z",
        endedAt: "2026-11-28T00:00:25.000Z",
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
        startedAt: "2026-11-28T00:00:30.000Z",
        endedAt: null,
      },
    ];

    const openedThreads: Array<string> = [];

    await using screen = await render(
      <LunaWorkflowRunEnhancements
        environmentId={ENV_ID}
        node={node}
        steps={steps}
        onOpenThread={(target) => openedThreads.push(target.threadId)}
      >
        <div>原始时间线内容</div>
      </LunaWorkflowRunEnhancements>,
    );

    // Default tab is timeline
    await expect.element(screen.getByText("原始时间线内容")).toBeVisible();

    // Switch to graph tab
    await userEvent.click(screen.getByRole("tab", { name: "流程图" }));
    await expect.element(screen.getByText("已完成 #2")).toBeVisible();

    // Switch to Bot 协作 tab
    await userEvent.click(screen.getByRole("tab", { name: /Bot 协作/ }));
    await expect.element(screen.getByText("多 Bot 实时协作状态")).toBeVisible();
    await expect.element(screen.getByText("是否确认合入发布？")).toBeVisible();

    // Steer into agent thread
    await userEvent.click(screen.getByRole("button", { name: "查看 / 介入 (Steer)" }));
    expect(openedThreads).toContain("thread-impl-2");

    // Answer inline approval
    await userEvent.click(screen.getByRole("button", { name: "批准发布" }));
    expect(hoisted.answers).toHaveLength(1);
    expect(
      (hoisted.answers[0] as { readonly input: { readonly choice: string } }).input.choice,
    ).toBe("批准发布");
  });
});
