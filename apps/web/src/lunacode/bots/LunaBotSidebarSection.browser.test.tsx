import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  BotHandle,
  BotId,
  BotTaskActivityEntry,
  BotTaskId,
  EnvironmentId,
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BotClusterSnapshot,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { LunaBotSidebarSection } from "./LunaBotSidebarSection";

const ENV_ID = EnvironmentId.make("env-1");
const PROJECT_ID = ProjectId.make("project-1");

const hoisted = vi.hoisted(() => ({
  snapshot: null as BotClusterSnapshot | null,
  commands: [] as Array<{ readonly label: string; readonly payload: unknown }>,
  navigated: [] as Array<unknown>,
}));

vi.mock(import("../../hooks/useNowMinute"), () => ({
  useNowMinute: () => "2026-11-28T02:00:00.000Z",
}));

vi.mock(import("../../components/workflows/useWorkflowEnvironmentIds"), () => ({
  useWorkflowEnvironmentIds: () => [ENV_ID],
}));

vi.mock(import("../../state/query"), (() => ({
  useEnvironmentQuery: (arg: { readonly label?: string } | null) => {
    const label = arg?.label ?? "";
    if (label.includes("workflows") || label.includes("workflowsLive")) {
      return {
        data: { runs: [], questions: [] },
        error: null,
        isPending: false,
        isSuccess: true,
        dataUpdatedAt: 0,
        failure: null,
        refresh: () => {},
      };
    }
    return {
      data: hoisted.snapshot,
      error: null,
      isPending: false,
      isSuccess: true,
      dataUpdatedAt: 0,
      failure: null,
      refresh: () => {},
    };
  },
})) as never);

vi.mock(import("../../state/entities"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useProjects: () => [
      {
        id: PROJECT_ID,
        environmentId: ENV_ID,
        title: "Main Repo",
        workspaceRoot: "/workspace/main",
        defaultModelSelection: null,
        scripts: [],
        repositoryIdentity: null,
        createdAt: "2026-11-28T00:00:00.000Z",
        updatedAt: "2026-11-28T00:00:00.000Z",
      } as never,
    ],
  };
});

vi.mock(import("../../state/use-atom-command"), (() => ({
  useAtomCommand:
    (_command: unknown, opts?: { readonly label?: string }) => async (payload: unknown) => {
      hoisted.commands.push({ label: opts?.label ?? "unknown", payload });
      if (opts?.label === "sidebar bot ensure home thread") {
        return {
          _tag: "Success",
          value: { threadId: ThreadId.make("thread-home-new") },
        } as never;
      }
      return { _tag: "Success", value: { createdCount: 4 } } as never;
    },
})) as never);

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const permitted = Atom.make(true);
  const providers = Atom.make([]);
  const permissionAtom = () => permitted;
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providersValueAtom: () => providers as never,
      ensureBotHomeThread: { ...actual.serverEnvironment.ensureBotHomeThread, permissionAtom },
      seedBotPresets: { ...actual.serverEnvironment.seedBotPresets, permissionAtom },
      upsertBot: { ...actual.serverEnvironment.upsertBot, permissionAtom },
      dispatchBotWorker: { ...actual.serverEnvironment.dispatchBotWorker, permissionAtom },
      sendBotMessage: { ...actual.serverEnvironment.sendBotMessage, permissionAtom },
    },
  };
});

describe("LunaBotSidebarSection", () => {
  it("shows empty seed trigger, renders expandable Bot tree, ensures Home Chat lazily, and navigates workers", async () => {
    hoisted.commands = [];
    hoisted.navigated = [];
    hoisted.snapshot = {
      bots: [],
      tasks: [],
      updatedAt: IsoDateTime.make("2026-11-28T01:55:00.000Z"),
    };

    await using emptyScreen = await render(
      <LunaBotSidebarSection
        environmentId={ENV_ID}
        threads={[]}
        activeThreadKey={null}
        onNavigateToThread={(ref) => hoisted.navigated.push(ref)}
      />,
    );

    expect(page.getByRole("link", { name: /任务中心/ }).element()).toBeTruthy();
    expect(page.getByRole("link", { name: /自动化工作流/ }).element()).toBeTruthy();

    await userEvent.click(page.getByRole("button", { name: /加载预设集群/ }));
    expect(hoisted.commands.some((entry) => entry.label === "sidebar bot seed presets")).toBe(true);
    await emptyScreen.unmount();

    const workerThreadId = ThreadId.make("thread-worker-1");
    hoisted.snapshot = {
      bots: [
        {
          id: BotId.make("bot-scout"),
          name: "Scout",
          handle: BotHandle.make("scout"),
          role: "缺陷侦察与复现",
          avatar: "scout",
          accent: "info",
          systemPrompt: "Scout bugs",
          defaultProjectId: PROJECT_ID,
          providerInstanceId: null,
          model: null,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: "worktree",
          homeThreadId: null,
          linkedWorkflowNames: [],
          linkedScheduledTaskIds: [],
          createdAt: IsoDateTime.make("2026-11-28T01:00:00.000Z"),
          updatedAt: IsoDateTime.make("2026-11-28T01:50:00.000Z"),
        },
      ],
      tasks: [
        {
          id: BotTaskId.make("task-1"),
          number: PositiveInt.make(1),
          botId: BotId.make("bot-scout"),
          title: "Fix Safari click",
          doneMeans: "Tap pays cleanly",
          status: "needs_you",
          projectId: PROJECT_ID,
          homeThreadId: null,
          workerThreadIds: [workerThreadId],
          workflowRunIds: [],
          linkedPrUrls: [],
          pendingQuestion: {
            prompt: "Ship behind flag?",
            choices: ["灰度开关"],
            askedAt: IsoDateTime.make("2026-11-28T01:55:00.000Z"),
          },
          activity: [
            BotTaskActivityEntry.make({
              id: "act-1",
              at: IsoDateTime.make("2026-11-28T01:50:00.000Z"),
              actor: "bot",
              actorLabel: "Scout",
              kind: "created",
              text: "Opened task",
            }),
          ],
          createdAt: IsoDateTime.make("2026-11-28T01:50:00.000Z"),
          updatedAt: IsoDateTime.make("2026-11-28T01:55:00.000Z"),
        },
      ],
      updatedAt: IsoDateTime.make("2026-11-28T01:55:00.000Z"),
    };

    const workerThread = {
      environmentId: ENV_ID,
      id: workerThreadId,
      projectId: PROJECT_ID,
      title: "safari-pay-click",
      updatedAt: "2026-11-28T01:58:00.000Z",
      deletedAt: null,
      archivedAt: null,
      runtime: {
        status: "running",
        activeRunId: null,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: "Codex",
        lastError: null,
        updatedAt: "2026-11-28T01:58:00.000Z",
      },
    } as unknown as EnvironmentThreadShell;

    await using treeScreen = await render(
      <LunaBotSidebarSection
        environmentId={ENV_ID}
        threads={[workerThread]}
        activeThreadKey={null}
        onNavigateToThread={(ref) => hoisted.navigated.push(ref)}
      />,
    );

    expect(page.getByText("Scout").element()).toBeTruthy();
    expect(page.getByText("待确认 1").element()).toBeTruthy();
    expect(page.getByText("1 工作中").element()).toBeTruthy();
    expect(treeScreen.container.querySelector("img")).toBeTruthy();

    await userEvent.click(page.getByRole("button", { name: /safari-pay-click/ }));
    expect(hoisted.navigated).toContainEqual({
      environmentId: ENV_ID,
      threadId: workerThreadId,
    });

    await userEvent.click(page.getByRole("button", { name: /Home Chat/ }));
    expect(hoisted.commands.some((entry) => entry.label === "sidebar bot ensure home thread")).toBe(
      true,
    );
    expect(hoisted.navigated).toContainEqual({
      environmentId: ENV_ID,
      threadId: ThreadId.make("thread-home-new"),
    });
    await treeScreen.unmount();
  });
});
