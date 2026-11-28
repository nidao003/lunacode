import type {
  BotClusterSnapshot,
  BotTask,
  BotTaskStatus,
  PersistentBot,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import { threadRuntimeIsActive, type ThreadStructureRuntime } from "../state/models.ts";

export interface BotThreadSummary {
  readonly id: ThreadId;
  readonly title: string;
  readonly projectId?: ProjectId | null;
  readonly updatedAt: string;
  readonly runtime: ThreadStructureRuntime | null;
  readonly deletedAt?: string | null;
}

export interface BotClusterTreeNode<TThread extends BotThreadSummary = BotThreadSummary> {
  readonly bot: PersistentBot;
  readonly homeThread: TThread | null;
  readonly isHomeWorking: boolean;
  readonly workers: ReadonlyArray<TThread>;
  readonly activeWorkerCount: number;
  readonly needsYouCount: number;
  readonly openTaskCount: number;
  readonly latestTask: BotTask | null;
  readonly latestActivityAt: string;
  readonly elapsedLabel: string;
}

export interface BotThreadContext {
  readonly bot: PersistentBot;
  readonly role: "home" | "worker";
  readonly activeTask: BotTask | null;
  readonly tasks: ReadonlyArray<BotTask>;
}

const STATUS_PRIORITY: Readonly<Record<BotTaskStatus, number>> = {
  needs_you: 0,
  in_progress: 1,
  backlog: 2,
  done: 3,
  cancelled: 4,
};

export function isBotThreadWorking(thread: BotThreadSummary | null | undefined): boolean {
  return Boolean(thread && thread.deletedAt == null && threadRuntimeIsActive(thread.runtime));
}

export function sortBotTasks(tasks: ReadonlyArray<BotTask>): ReadonlyArray<BotTask> {
  return [...tasks].sort((left, right) => {
    const rankDiff = STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status];
    if (rankDiff !== 0) return rankDiff;
    const updatedDiff = right.updatedAt.localeCompare(left.updatedAt);
    if (updatedDiff !== 0) return updatedDiff;
    return right.number - left.number;
  });
}

export function formatBotElapsedLabel(iso: string, nowMs: number): string {
  const parsedMs = Date.parse(iso);
  if (Number.isNaN(parsedMs)) return "";
  const diffMs = Math.max(0, nowMs - parsedMs);
  if (diffMs < 60_000) return "刚刚";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function sanitizeBotHandle(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[-_]+$/, "")
    .slice(0, 48);
  return /^[a-z0-9][a-z0-9_-]{0,47}$/.test(cleaned) ? cleaned : "bot";
}

export function extractPrShortLabel(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return "";
  try {
    const parsed = new URL(trimmed);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const pullIdx = parts.findIndex(
      (part) => part === "pull" || part === "merge_requests" || part === "pull-requests",
    );
    if (pullIdx >= 2) {
      const owner = parts[0];
      const repo = parts[1];
      const maybeNumber =
        parts[pullIdx] === "merge_requests" && parts[pullIdx - 1] === "-"
          ? parts[pullIdx + 1]
          : parts[pullIdx + 1];
      if (owner && repo && maybeNumber && /^\d+$/.test(maybeNumber)) {
        return `${owner}/${repo}#${maybeNumber}`;
      }
    }
    const tail = parts.slice(-2).join("/");
    return tail ? `${parsed.hostname}/${tail}` : parsed.hostname;
  } catch {
    return trimmed.slice(0, 42);
  }
}

export function buildBotClusterTree<TThread extends BotThreadSummary>(
  snapshot: BotClusterSnapshot,
  threadsById: ReadonlyMap<ThreadId, TThread>,
  nowMs: number,
): ReadonlyArray<BotClusterTreeNode<TThread>> {
  const tasksByBot = new Map<string, Array<BotTask>>();
  for (const task of snapshot.tasks) {
    const bucket = tasksByBot.get(task.botId);
    if (bucket) {
      bucket.push(task);
    } else {
      tasksByBot.set(task.botId, [task]);
    }
  }

  const nodes: Array<BotClusterTreeNode<TThread>> = [];
  for (const bot of snapshot.bots) {
    if (bot.archived === true) continue;

    const rawTasks = tasksByBot.get(bot.id) ?? [];
    const sortedTasks = sortBotTasks(rawTasks);
    const latestTask = sortedTasks[0] ?? null;

    const rawHomeThread =
      bot.homeThreadId !== null ? (threadsById.get(bot.homeThreadId) ?? null) : null;
    const homeThread =
      rawHomeThread !== null && rawHomeThread.deletedAt == null ? rawHomeThread : null;

    const seenWorkers = new Set<ThreadId>();
    const workers: Array<TThread> = [];
    for (const task of sortedTasks) {
      for (const workerThreadId of task.workerThreadIds) {
        if (workerThreadId === bot.homeThreadId || seenWorkers.has(workerThreadId)) continue;
        seenWorkers.add(workerThreadId);
        const thread = threadsById.get(workerThreadId);
        if (thread && thread.deletedAt == null) {
          workers.push(thread);
        }
      }
    }
    workers.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    const activeWorkerCount = workers.filter((thread) => isBotThreadWorking(thread)).length;
    const isHomeWorking = isBotThreadWorking(homeThread);
    const needsYouCount = rawTasks.filter(
      (task) => task.status === "needs_you" || task.pendingQuestion !== null,
    ).length;
    const openTaskCount = rawTasks.filter(
      (task) => task.status !== "done" && task.status !== "cancelled",
    ).length;

    let latestActivityAt = bot.updatedAt;
    for (const candidate of [homeThread?.updatedAt, latestTask?.updatedAt, workers[0]?.updatedAt]) {
      if (candidate && candidate.localeCompare(latestActivityAt) > 0) {
        latestActivityAt = candidate;
      }
    }

    nodes.push({
      bot,
      homeThread,
      isHomeWorking,
      workers,
      activeWorkerCount,
      needsYouCount,
      openTaskCount,
      latestTask,
      latestActivityAt,
      elapsedLabel: formatBotElapsedLabel(latestActivityAt, nowMs),
    });
  }

  return nodes;
}

export function findBotContextForThread(
  snapshot: BotClusterSnapshot,
  threadId: ThreadId | null | undefined,
): BotThreadContext | null {
  if (!threadId) return null;

  const homeBot = snapshot.bots.find((bot) => !bot.archived && bot.homeThreadId === threadId);
  if (homeBot) {
    const tasks = sortBotTasks(snapshot.tasks.filter((task) => task.botId === homeBot.id));
    return {
      bot: homeBot,
      role: "home",
      activeTask: tasks[0] ?? null,
      tasks,
    };
  }

  const workerTask = snapshot.tasks.find((task) => task.workerThreadIds.includes(threadId));
  if (!workerTask) return null;

  const workerBot = snapshot.bots.find((bot) => !bot.archived && bot.id === workerTask.botId);
  if (!workerBot) return null;

  const tasks = sortBotTasks(snapshot.tasks.filter((task) => task.botId === workerBot.id));
  return {
    bot: workerBot,
    role: "worker",
    activeTask: workerTask,
    tasks,
  };
}
