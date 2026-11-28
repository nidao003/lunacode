import {
  BotHandle,
  BotId,
  BotTaskId,
  EnvironmentId,
  IsoDateTime,
  PositiveInt,
  ProjectId,
  type BotClusterSnapshot,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { SidebarProvider } from "../../components/ui/sidebar";
import { render } from "../../../test/render";
import { LunaBotsWorkspace } from "./LunaBotsWorkspace";

const ENV_ID = EnvironmentId.make("env-1");
const PROJECT_ID = ProjectId.make("project-1");

const hoisted = vi.hoisted(() => ({
  commands: [] as Array<{ readonly label: string; readonly payload: unknown }>,
  search: {} as Record<string, unknown>,
  snapshot: null as BotClusterSnapshot | null,
}));

vi.mock(import("@tanstack/react-router"), (async (
  original: () => Promise<Record<string, unknown>>,
) => {
  const actual = await original();
  return {
    ...actual,
    useSearch: () => hoisted.search,
    useNavigate: () => vi.fn(async () => {}),
  };
}) as never);

vi.mock(import("../../hooks/useNowMinute"), () => ({
  useNowMinute: () => "2026-11-28T03:00:00.000Z",
}));

vi.mock(import("../../components/workflows/useWorkflowEnvironmentIds"), () => ({
  useWorkflowEnvironmentIds: () => [ENV_ID],
}));

vi.mock(import("../../state/query"), (() => ({
  useEnvironmentQuery: (arg: unknown) => {
    const label = (arg as { label?: string } | null)?.label;
    if (label && String(label).includes("definition")) {
      return {
        data: {
          directory: "/tmp/wf",
          single: false,
          revision: 1,
          problem: null,
          problems: [],
          files: [],
        },
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

vi.mock(import("../../state/environments"), (async (
  original: () => Promise<Record<string, unknown>>,
) => {
  const actual = await original();
  return {
    ...actual,
    usePrimaryEnvironmentId: () => ENV_ID,
    useEnvironments: () => ({
      environments: [{ environmentId: ENV_ID, label: "Local", connected: true }],
    }),
  };
}) as never);

vi.mock(import("../../state/entities"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useQuietThreadShells: () => [],
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
      seedBotPresets: { ...actual.serverEnvironment.seedBotPresets, permissionAtom },
      upsertBotTask: { ...actual.serverEnvironment.upsertBotTask, permissionAtom },
      commentBotTask: { ...actual.serverEnvironment.commentBotTask, permissionAtom },
      answerBotTask: { ...actual.serverEnvironment.answerBotTask, permissionAtom },
      ensureBotHomeThread: { ...actual.serverEnvironment.ensureBotHomeThread, permissionAtom },
      deleteBot: { ...actual.serverEnvironment.deleteBot, permissionAtom },
      upsertBot: { ...actual.serverEnvironment.upsertBot, permissionAtom },
      dispatchBotWorker: { ...actual.serverEnvironment.dispatchBotWorker, permissionAtom },
      sendBotMessage: { ...actual.serverEnvironment.sendBotMessage, permissionAtom },
      startWorkflowRun: { ...actual.serverEnvironment.startWorkflowRun, permissionAtom },
      saveWorkflowDefinition: {
        ...actual.serverEnvironment.saveWorkflowDefinition,
        permissionAtom,
      },
      updateSettings: { ...actual.serverEnvironment.updateSettings, permissionAtom },
    },
  };
});

describe("LunaBotsWorkspace", () => {
  it("renders tasks hub, submits needs_you decision, adds comment, and opens New Bot modal", async () => {
    hoisted.commands = [];
    hoisted.search = { tab: "tasks" };
    hoisted.snapshot = {
      bots: [
        {
          id: BotId.make("bot-scout"),
          name: "Scout",
          handle: BotHandle.make("scout"),
          role: "缺陷侦察",
          avatar: "scout",
          accent: "info",
          systemPrompt: "Scout",
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
          updatedAt: IsoDateTime.make("2026-11-28T02:00:00.000Z"),
        },
      ],
      tasks: [
        {
          id: BotTaskId.make("task-41"),
          number: PositiveInt.make(41),
          botId: BotId.make("bot-scout"),
          title: "Pay button ignores first tap on Safari",
          doneMeans: "Tap pays on Safari 18",
          status: "needs_you",
          projectId: PROJECT_ID,
          homeThreadId: null,
          workerThreadIds: [],
          workflowRunIds: [],
          linkedPrUrls: ["https://github.com/acme/web/pull/1287"],
          pendingQuestion: {
            prompt: "Ship behind safari_pay_click flag?",
            choices: ["灰度开关", "全量发布"],
            askedAt: IsoDateTime.make("2026-11-28T02:30:00.000Z"),
          },
          activity: [],
          createdAt: IsoDateTime.make("2026-11-28T02:00:00.000Z"),
          updatedAt: IsoDateTime.make("2026-11-28T02:30:00.000Z"),
        },
      ],
      updatedAt: IsoDateTime.make("2026-11-28T02:30:00.000Z"),
    };

    await using screen = await render(
      <SidebarProvider>
        <LunaBotsWorkspace />
      </SidebarProvider>,
    );

    expect(
      page.getByRole("heading", { name: /Pay button ignores first tap on Safari/ }).element(),
    ).toBeTruthy();
    expect(page.getByRole("link", { name: /acme\/web#1287/ }).element()).toBeTruthy();

    await userEvent.click(page.getByRole("button", { name: "灰度开关" }));
    expect(
      hoisted.commands.some(
        (c) =>
          c.label === "bot task answer" &&
          (c.payload as { input?: { choice?: string } }).input?.choice === "灰度开关",
      ),
    ).toBe(true);

    const commentInput = page.getByPlaceholder("+ 添加评论或追问...");
    await userEvent.type(commentInput, "先灰度 10% 观察错误率");
    await userEvent.click(page.getByRole("button", { name: "发送评论" }));
    expect(
      hoisted.commands.some(
        (c) =>
          c.label === "bot task comment" &&
          (c.payload as { input?: { text?: string } }).input?.text === "先灰度 10% 观察错误率",
      ),
    ).toBe(true);

    await userEvent.click(page.getByRole("button", { name: /新建 Bot/ }));
    expect(page.getByText("新建常驻协作 Bot").element()).toBeTruthy();
    expect(page.getByText("真人风格头像").element()).toBeTruthy();
    await screen.unmount();

    hoisted.search = { tab: "bots" };
    await using botsTabScreen = await render(
      <SidebarProvider>
        <LunaBotsWorkspace />
      </SidebarProvider>,
    );
    expect(page.getByRole("button", { name: /补齐默认团队/ }).element()).toBeTruthy();
    expect(botsTabScreen.container.querySelector("img")).toBeTruthy();
    await botsTabScreen.unmount();

    hoisted.search = { tab: "automations" };
    await using automationsScreen = await render(
      <SidebarProvider>
        <LunaBotsWorkspace />
      </SidebarProvider>,
    );
    expect(page.getByText(/精选可视化工作流案例库（共 8 套）/).element()).toBeTruthy();
    expect(page.getByText("Bug 复现与并行修复").element()).toBeTruthy();
    await automationsScreen.unmount();
  });
});
