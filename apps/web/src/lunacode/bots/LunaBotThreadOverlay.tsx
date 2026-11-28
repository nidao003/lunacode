import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { findBotContextForThread } from "@t3tools/client-runtime/lunacode/bots";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type {
  BotTaskId,
  EnvironmentId,
  PersistentBot,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { PanelRightIcon, PlayIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useProjects, useQuietThreadShells } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { BOT_TASK_STATUS_META, LunaBotAvatar } from "./LunaBotAvatar";
import { LunaBotDispatchDialog } from "./LunaBotDispatchDialog";
import { LunaBotTaskDetailPanel } from "./LunaBotTaskDetailPanel";

export function LunaBotThreadBanner({
  environmentId,
  threadId,
  drawerOpen,
  onToggleDrawer,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly drawerOpen: boolean;
  readonly onToggleDrawer: () => void;
}) {
  const navigate = useNavigate();
  const botsQuery = useEnvironmentQuery(serverEnvironment.botsLive({ environmentId, input: {} }));
  const snapshot = botsQuery.data;
  const ctx = snapshot ? findBotContextForThread(snapshot, threadId) : null;

  const [dispatchOpen, setDispatchOpen] = useState(false);

  if (!ctx || !snapshot) return null;

  return (
    <div
      data-lunacode-bot-banner="true"
      className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-1.5 text-xs sm:px-5"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <LunaBotAvatar avatar={ctx.bot.avatar} accent={ctx.bot.accent} size="sm" />
        <Link
          to="/bots"
          search={{ env: environmentId, bot: ctx.bot.id }}
          className="font-semibold text-foreground hover:text-primary"
        >
          {ctx.bot.name}
        </Link>
        <Badge size="sm" variant={ctx.role === "home" ? "outline" : "info"}>
          {ctx.role === "home" ? "Home Chat" : "Worker"}
        </Badge>
        {ctx.role === "worker" && ctx.bot.homeThreadId ? (
          <button
            type="button"
            className="cursor-pointer rounded px-1.5 py-0.5 text-2xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(
                  scopeThreadRef(environmentId, ctx.bot.homeThreadId!),
                ),
              })
            }
          >
            回到主对话 →
          </button>
        ) : null}
        {ctx.activeTask ? (
          <button
            type="button"
            className="inline-flex max-w-[260px] cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-2 py-0.5 text-2xs text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() => {
              if (!drawerOpen) onToggleDrawer();
            }}
          >
            <span className="font-mono text-muted-foreground">#{ctx.activeTask.number}</span>
            <span className="truncate">{ctx.activeTask.title}</span>
            <Badge size="sm" variant={BOT_TASK_STATUS_META[ctx.activeTask.status].badgeVariant}>
              {BOT_TASK_STATUS_META[ctx.activeTask.status].label}
            </Badge>
          </button>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <Button size="micro" variant="outline" onClick={() => setDispatchOpen(true)}>
          <PlayIcon />
          派发 Worker
        </Button>
        <Button size="micro" variant={drawerOpen ? "default" : "outline"} onClick={onToggleDrawer}>
          <PanelRightIcon />
          {drawerOpen ? "收起任务面板" : "任务面板"}
        </Button>
      </div>

      <LunaBotDispatchDialog
        open={dispatchOpen}
        environmentId={environmentId}
        bots={snapshot.bots}
        tasks={snapshot.tasks}
        defaultBotId={ctx.bot.id}
        defaultTaskId={ctx.activeTask?.id ?? null}
        defaultProjectId={ctx.bot.defaultProjectId}
        onOpenChange={setDispatchOpen}
        onDispatched={(targetThreadId, targetEnvId) => {
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(targetEnvId, targetThreadId)),
          });
        }}
      />
    </div>
  );
}

export function LunaBotRightDrawer({
  environmentId,
  threadId,
  open,
  yieldToNativeRightPanel,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly open: boolean;
  readonly yieldToNativeRightPanel: boolean;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  const botsQuery = useEnvironmentQuery(serverEnvironment.botsLive({ environmentId, input: {} }));
  const snapshot = botsQuery.data;
  const ctx = snapshot ? findBotContextForThread(snapshot, threadId) : null;
  const allThreads = useQuietThreadShells();
  const allProjects = useProjects();
  const nowMinuteIso = useNowMinute();
  const parsedNow = Date.parse(nowMinuteIso);
  const nowMs = Number.isNaN(parsedNow) ? 0 : parsedNow;

  const canOperate = useAtomValue(
    serverEnvironment.ensureBotHomeThread.permissionAtom(environmentId),
  );
  const ensureHome = useAtomCommand(serverEnvironment.ensureBotHomeThread, {
    label: "drawer bot ensure home thread",
    reportFailure: false,
  });

  const [selectedTaskId, setSelectedTaskId] = useState<BotTaskId | null>(null);
  const [dispatchOpen, setDispatchOpen] = useState(false);

  if (!open || yieldToNativeRightPanel || !ctx || !snapshot) {
    return null;
  }

  const threadsById = new Map<ThreadId, EnvironmentThreadShell>();
  for (const thread of allThreads) {
    if (thread.environmentId === environmentId && thread.deletedAt === null) {
      threadsById.set(thread.id, thread);
    }
  }
  const projectsById = new Map<ProjectId, EnvironmentProject>();
  for (const project of allProjects) {
    if (project.environmentId === environmentId) {
      projectsById.set(project.id, project);
    }
  }

  const selectedTask =
    (selectedTaskId ? ctx.tasks.find((item) => item.id === selectedTaskId) : undefined) ??
    ctx.activeTask;

  const handleOpenThread = (targetThreadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, targetThreadId)),
    });
  };

  const handleEnsureHome = async (bot: PersistentBot) => {
    if (bot.homeThreadId) {
      handleOpenThread(bot.homeThreadId);
      return;
    }
    if (!canOperate) return;
    const result = await ensureHome({
      environmentId,
      input: {
        botId: bot.id,
        ...(bot.defaultProjectId ? { projectId: bot.defaultProjectId } : {}),
      },
    });
    if (result._tag === "Success") {
      handleOpenThread(result.value.threadId);
    } else if (!isAtomCommandInterrupted(result)) {
      return;
    }
  };

  return (
    <aside
      data-lunacode-bot-drawer="true"
      aria-label="Bot 任务详情侧栏"
      className="fixed inset-y-0 right-0 z-40 flex h-full w-[min(92vw,360px)] shrink-0 flex-col border-l border-border bg-background shadow-2xl lg:static lg:z-auto lg:w-[350px] xl:w-[390px] lg:shadow-none"
    >
      <div className="flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center justify-between border-b border-border px-3 md:pr-32">
        <div className="flex min-w-0 items-center gap-2">
          <LunaBotAvatar avatar={ctx.bot.avatar} accent={ctx.bot.accent} size="sm" />
          <span className="truncate text-xs font-semibold text-foreground">
            {ctx.bot.name} · 任务详情
          </span>
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          className="lg:hidden"
          aria-label="关闭任务侧栏"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>

      <div className="min-h-0 flex-1">
        <LunaBotTaskDetailPanel
          environmentId={environmentId}
          bot={ctx.bot}
          task={selectedTask}
          allTasksForBot={ctx.tasks}
          threadsById={threadsById}
          projectsById={projectsById}
          nowMs={nowMs}
          onSelectTask={(taskId) => setSelectedTaskId(taskId)}
          onOpenThread={handleOpenThread}
          onEnsureHomeThread={(bot) => void handleEnsureHome(bot)}
          onDispatchWorker={() => setDispatchOpen(true)}
        />
      </div>

      <LunaBotDispatchDialog
        open={dispatchOpen}
        environmentId={environmentId}
        bots={snapshot.bots}
        tasks={snapshot.tasks}
        defaultBotId={ctx.bot.id}
        defaultTaskId={selectedTask?.id ?? null}
        defaultProjectId={ctx.bot.defaultProjectId}
        onOpenChange={setDispatchOpen}
        onDispatched={(targetThreadId) => handleOpenThread(targetThreadId)}
      />
    </aside>
  );
}
