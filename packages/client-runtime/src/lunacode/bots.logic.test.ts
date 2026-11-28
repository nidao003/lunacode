import {
  BotHandle,
  BotId,
  BotTaskId,
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type BotClusterSnapshot,
  type BotTask,
  type PersistentBot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildBotClusterTree,
  extractPrShortLabel,
  findBotContextForThread,
  formatBotElapsedLabel,
  sanitizeBotHandle,
  sortBotTasks,
  type BotThreadSummary,
} from "./bots.logic.ts";

const iso = (value: string) => IsoDateTime.make(value);

function makeBot(
  partial: Omit<Partial<PersistentBot>, "id" | "handle"> & {
    id: string;
    handle: string;
    name: string;
  },
): PersistentBot {
  return {
    role: "Repo Scout",
    avatar: "scout",
    accent: "info",
    systemPrompt: "Scout bugs",
    defaultProjectId: ProjectId.make("proj-1"),
    providerInstanceId: null,
    model: null,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: "worktree",
    homeThreadId: null,
    linkedWorkflowNames: [],
    linkedScheduledTaskIds: [],
    createdAt: iso("2026-11-28T00:00:00.000Z"),
    updatedAt: iso("2026-11-28T00:00:00.000Z"),
    ...partial,
    id: BotId.make(partial.id),
    handle: BotHandle.make(partial.handle),
  };
}

function makeTask(
  partial: Omit<Partial<BotTask>, "id" | "number" | "botId"> & {
    id: string;
    number: number;
    botId: string;
    title: string;
  },
): BotTask {
  return {
    doneMeans: null,
    status: "in_progress",
    projectId: ProjectId.make("proj-1"),
    homeThreadId: null,
    workerThreadIds: [],
    workflowRunIds: [],
    linkedPrUrls: [],
    pendingQuestion: null,
    activity: [],
    createdAt: iso("2026-11-28T00:00:00.000Z"),
    updatedAt: iso("2026-11-28T00:00:00.000Z"),
    ...partial,
    id: BotTaskId.make(partial.id),
    number: PositiveInt.make(partial.number),
    botId: BotId.make(partial.botId),
  };
}

function makeThread(
  id: string,
  updatedAt: string,
  status: "running" | "completed" | "idle" = "idle",
): BotThreadSummary {
  return {
    id: ThreadId.make(id),
    title: `Thread ${id}`,
    projectId: ProjectId.make("proj-1"),
    updatedAt,
    deletedAt: null,
    runtime: {
      status,
      activeRunId: status === "running" ? RunId.make(`run-${id}`) : null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: "Codex",
      lastError: null,
    },
  };
}

describe("lunacode/bots.logic", () => {
  it("builds cluster tree with home chat, active workers, needs_you counts, and elapsed label", () => {
    const homeId = ThreadId.make("thread-home");
    const worker1 = ThreadId.make("thread-w1");
    const worker2 = ThreadId.make("thread-w2");
    const archivedBot = makeBot({
      id: "bot-archived",
      name: "Archived",
      handle: "archived",
      archived: true,
    });
    const scout = makeBot({
      id: "bot-scout",
      name: "Scout",
      handle: "scout",
      homeThreadId: homeId,
      updatedAt: iso("2026-11-28T01:00:00.000Z"),
    });
    const tasks: ReadonlyArray<BotTask> = [
      makeTask({
        id: "task-1",
        number: 1,
        botId: "bot-scout",
        title: "Investigate Safari tap",
        status: "needs_you",
        homeThreadId: homeId,
        workerThreadIds: [worker1, worker2, worker1],
        pendingQuestion: {
          prompt: "Ship behind feature flag?",
          choices: ["Behind flag", "Ship all"],
          askedAt: iso("2026-11-28T01:05:00.000Z"),
        },
        updatedAt: iso("2026-11-28T01:05:00.000Z"),
      }),
      makeTask({
        id: "task-2",
        number: 2,
        botId: "bot-scout",
        title: "Previous cleanup",
        status: "done",
        updatedAt: iso("2026-11-27T12:00:00.000Z"),
      }),
    ];
    const snapshot: BotClusterSnapshot = {
      bots: [scout, archivedBot],
      tasks,
      updatedAt: iso("2026-11-28T01:05:00.000Z"),
    };
    const threads = new Map<ThreadId, BotThreadSummary>([
      [homeId, makeThread(homeId, "2026-11-28T01:04:00.000Z", "idle")],
      [worker1, makeThread(worker1, "2026-11-28T01:06:00.000Z", "running")],
      [worker2, makeThread(worker2, "2026-11-28T01:02:00.000Z", "completed")],
    ]);

    const nowMs = Date.parse("2026-11-28T01:12:00.000Z");
    const tree = buildBotClusterTree(snapshot, threads, nowMs);

    expect(tree).toHaveLength(1);
    const node = tree[0]!;
    expect(node.bot.id).toBe(scout.id);
    expect(node.homeThread?.id).toBe(homeId);
    expect(node.workers.map((w) => w.id)).toEqual([worker1, worker2]);
    expect(node.activeWorkerCount).toBe(1);
    expect(node.needsYouCount).toBe(1);
    expect(node.openTaskCount).toBe(1);
    expect(node.latestTask?.id).toBe(tasks[0]!.id);
    expect(node.elapsedLabel).toBe("6m");
  });

  it("finds Bot context for home chat, worker thread, and unrelated threads", () => {
    const homeId = ThreadId.make("home-1");
    const workerId = ThreadId.make("worker-1");
    const unrelatedId = ThreadId.make("other-1");
    const snapshot: BotClusterSnapshot = {
      bots: [makeBot({ id: "bot-1", name: "Scout", handle: "scout", homeThreadId: homeId })],
      tasks: [
        makeTask({
          id: "t-1",
          number: 1,
          botId: "bot-1",
          title: "Track CI",
          status: "in_progress",
          workerThreadIds: [workerId],
        }),
      ],
      updatedAt: iso("2026-11-28T00:00:00.000Z"),
    };

    const homeCtx = findBotContextForThread(snapshot, homeId);
    expect(homeCtx?.role).toBe("home");
    expect(homeCtx?.bot.handle).toBe("scout");
    expect(homeCtx?.activeTask?.number).toBe(1);

    const workerCtx = findBotContextForThread(snapshot, workerId);
    expect(workerCtx?.role).toBe("worker");
    expect(workerCtx?.activeTask?.title).toBe("Track CI");

    expect(findBotContextForThread(snapshot, unrelatedId)).toBeNull();
  });

  it("sorts tasks by needs_you -> in_progress -> backlog -> done -> cancelled and recency", () => {
    const sorted = sortBotTasks([
      makeTask({
        id: "t-done",
        number: 1,
        botId: "b",
        title: "Done",
        status: "done",
        updatedAt: iso("2026-11-28T10:00:00.000Z"),
      }),
      makeTask({
        id: "t-backlog",
        number: 2,
        botId: "b",
        title: "Backlog",
        status: "backlog",
        updatedAt: iso("2026-11-28T09:00:00.000Z"),
      }),
      makeTask({
        id: "t-progress",
        number: 3,
        botId: "b",
        title: "Progress",
        status: "in_progress",
        updatedAt: iso("2026-11-28T01:00:00.000Z"),
      }),
      makeTask({
        id: "t-needs",
        number: 4,
        botId: "b",
        title: "Needs",
        status: "needs_you",
        updatedAt: iso("2026-11-27T01:00:00.000Z"),
      }),
    ]);

    expect(sorted.map((item) => item.id)).toEqual(["t-needs", "t-progress", "t-backlog", "t-done"]);
  });

  it("formats elapsed labels, sanitizes handles, and extracts PR short labels", () => {
    const now = Date.parse("2026-11-28T12:00:00.000Z");
    expect(formatBotElapsedLabel("2026-11-28T11:59:30.000Z", now)).toBe("刚刚");
    expect(formatBotElapsedLabel("2026-11-28T11:45:00.000Z", now)).toBe("15m");
    expect(formatBotElapsedLabel("2026-11-28T09:00:00.000Z", now)).toBe("3h");
    expect(formatBotElapsedLabel("2026-11-26T12:00:00.000Z", now)).toBe("2d");

    expect(sanitizeBotHandle("  @Review Buddy! ")).toBe("review-buddy");
    expect(sanitizeBotHandle("---")).toBe("bot");

    expect(extractPrShortLabel("https://github.com/acme/web/pull/1287")).toBe("acme/web#1287");
    expect(extractPrShortLabel("https://gitlab.com/org/repo/-/merge_requests/42")).toBe(
      "org/repo#42",
    );
  });
});
