import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  buildBotClusterTree,
  formatBotElapsedLabel,
  isBotThreadWorking,
} from "@t3tools/client-runtime/lunacode/bots";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  BotId,
  EnvironmentId,
  PersistentBot,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import {
  BotIcon,
  CheckSquareIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  MessageSquareIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  Settings2Icon,
  WorkflowIcon,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useWorkflowEnvironmentIds } from "~/components/workflows/useWorkflowEnvironmentIds";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { BOT_ACCENT_STYLES, LunaBotAvatar, extractBotErrorMessage } from "./LunaBotAvatar";
import { LunaBotConfigDialog } from "./LunaBotConfigDialog";
import { LunaBotDispatchDialog } from "./LunaBotDispatchDialog";

export function LunaBotSidebarSection({
  environmentId,
  threads,
  activeThreadKey,
  onNavigateToThread,
  onCloseMobileSidebar,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly activeThreadKey: string | null;
  readonly onNavigateToThread: (threadRef: ScopedThreadRef) => void;
  readonly onCloseMobileSidebar?: (() => void) | undefined;
}) {
  const botsQuery = useEnvironmentQuery(
    environmentId ? serverEnvironment.botsLive({ environmentId, input: {} }) : null,
  );
  const workflowEnvIds = useWorkflowEnvironmentIds();
  const workflowsEnabled = Boolean(environmentId && workflowEnvIds.includes(environmentId));
  const workflowsQuery = useEnvironmentQuery(
    workflowsEnabled && environmentId
      ? serverEnvironment.workflowsLive({ environmentId, input: {} })
      : null,
  );
  const snapshot = botsQuery.data;
  const wfQuestionsCount = workflowsQuery.data?.questions?.length ?? 0;
  const wfActiveRunsCount =
    workflowsQuery.data?.runs?.filter((run) => run.status === "running").length ?? 0;
  const nowMinuteIso = useNowMinute();
  const parsedNow = Date.parse(nowMinuteIso);
  const nowMs = Number.isNaN(parsedNow) ? 0 : parsedNow;

  const canOperate = useAtomValue(
    serverEnvironment.ensureBotHomeThread.permissionAtom(environmentId),
  );
  const canSeed = useAtomValue(serverEnvironment.seedBotPresets.permissionAtom(environmentId));

  const ensureHome = useAtomCommand(serverEnvironment.ensureBotHomeThread, {
    label: "sidebar bot ensure home thread",
    reportFailure: false,
  });
  const seedPresets = useAtomCommand(serverEnvironment.seedBotPresets, {
    label: "sidebar bot seed presets",
    reportFailure: false,
  });

  const [botsCollapsed, setBotsCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [expandedOverrides, setExpandedOverrides] = useState<Readonly<Record<string, boolean>>>({});
  const [configOpen, setConfigOpen] = useState(false);
  const [editingBot, setEditingBot] = useState<PersistentBot | null>(null);
  const [dispatchBotId, setDispatchBotId] = useState<BotId | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const threadsById = new Map<ThreadId, EnvironmentThreadShell>();
  if (environmentId) {
    for (const thread of threads) {
      if (thread.environmentId === environmentId && thread.deletedAt === null) {
        threadsById.set(thread.id, thread);
      }
    }
  }

  const allNodes = snapshot ? buildBotClusterTree(snapshot, threadsById, nowMs) : [];
  const normalizedQuery = searchText.trim().toLowerCase();
  const filteredNodes = normalizedQuery
    ? allNodes.filter(
        (node) =>
          node.bot.name.toLowerCase().includes(normalizedQuery) ||
          node.bot.handle.toLowerCase().includes(normalizedQuery) ||
          node.bot.role.toLowerCase().includes(normalizedQuery) ||
          (node.latestTask?.title.toLowerCase().includes(normalizedQuery) ?? false),
      )
    : allNodes;

  const totalNeedsYou = allNodes.reduce((sum, node) => sum + node.needsYouCount, 0);
  const totalWorking = allNodes.reduce(
    (sum, node) => sum + node.activeWorkerCount + (node.isHomeWorking ? 1 : 0),
    0,
  );

  const isBotExpanded = (nodeId: BotId, index: number, isActiveBot: boolean) => {
    const override = expandedOverrides[nodeId];
    if (override !== undefined) return override;
    return isActiveBot || index === 0;
  };

  const toggleBotExpanded = (botId: BotId, currentlyExpanded: boolean) => {
    setExpandedOverrides((prev) => ({
      ...prev,
      [botId]: !currentlyExpanded,
    }));
  };

  const handleOpenHomeChat = async (bot: PersistentBot) => {
    if (!environmentId) return;
    setErrorMessage(null);
    if (bot.homeThreadId) {
      onCloseMobileSidebar?.();
      onNavigateToThread(scopeThreadRef(environmentId, bot.homeThreadId));
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
      onCloseMobileSidebar?.();
      onNavigateToThread(scopeThreadRef(environmentId, result.value.threadId));
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setErrorMessage(extractBotErrorMessage(squashAtomCommandFailure(result)));
    }
  };

  const handleSeedPresets = async () => {
    if (!environmentId || !canSeed || seeding) return;
    setSeeding(true);
    setErrorMessage(null);
    const result = await seedPresets({
      environmentId,
      input: {},
    });
    setSeeding(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setErrorMessage(extractBotErrorMessage(squashAtomCommandFailure(result)));
    }
  };

  return (
    <div data-lunacode-bots-sidebar="true" className="mb-2 border-b border-sidebar-border/70 pb-2">
      {/* Top Orca Shortcuts: Tasks + Automations */}
      <div className="space-y-0.5 px-1">
        <Link
          to="/bots"
          search={{ ...(environmentId ? { env: environmentId } : {}), tab: "tasks" }}
          onClick={() => onCloseMobileSidebar?.()}
          className="flex h-7 w-full items-center justify-between gap-2 rounded-md px-2 text-xs font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className="flex min-w-0 items-center gap-2">
            <CheckSquareIcon className="size-3.5 shrink-0 opacity-80" />
            <span className="truncate">任务中心</span>
          </span>
          {totalNeedsYou > 0 ? (
            <Badge size="sm" variant="warning">
              {totalNeedsYou}
            </Badge>
          ) : null}
        </Link>

        <Link
          to="/workflows"
          search={environmentId ? { env: environmentId } : {}}
          onClick={() => onCloseMobileSidebar?.()}
          className="flex h-7 w-full items-center justify-between gap-2 rounded-md px-2 text-xs font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className="flex min-w-0 items-center gap-2">
            <WorkflowIcon className="size-3.5 shrink-0 opacity-80" />
            <span className="truncate">自动化工作流</span>
          </span>
          {wfQuestionsCount > 0 ? (
            <Badge size="sm" variant="warning">
              待审批 {wfQuestionsCount}
            </Badge>
          ) : wfActiveRunsCount > 0 ? (
            <Badge size="sm" variant="info">
              {wfActiveRunsCount} 运行中
            </Badge>
          ) : null}
        </Link>
      </div>

      {/* Collapsible Bots Cluster Header */}
      <div className="mt-1.5 flex items-center justify-between gap-1 px-2 py-1">
        <button
          type="button"
          className="flex min-w-0 cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-2xs font-semibold text-sidebar-muted-foreground transition-colors hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => setBotsCollapsed((prev) => !prev)}
        >
          {botsCollapsed ? (
            <ChevronRightIcon className="size-3 shrink-0" />
          ) : (
            <ChevronDownIcon className="size-3 shrink-0" />
          )}
          <span>Bots</span>
          {allNodes.length > 0 ? (
            <span className="font-mono text-3xs opacity-70">({allNodes.length})</span>
          ) : null}
          {totalWorking > 0 ? (
            <Badge size="sm" variant="info" className="ml-1">
              {totalWorking} 工作中
            </Badge>
          ) : null}
        </button>

        <div className="flex items-center gap-0.5">
          <Button
            size="icon-tiny"
            variant="ghost-muted"
            aria-label="筛选 Bots"
            title="筛选 Bots"
            onClick={() => setSearchOpen((prev) => !prev)}
          >
            <SearchIcon />
          </Button>
          <Link
            to="/bots"
            search={{ ...(environmentId ? { env: environmentId } : {}), tab: "bots" }}
            onClick={() => onCloseMobileSidebar?.()}
            className="inline-flex size-4 items-center justify-center rounded text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            aria-label="管理 Bot 集群"
            title="管理 Bot 集群"
          >
            <BotIcon className="size-3" />
          </Link>
          <Button
            size="icon-tiny"
            variant="ghost-muted"
            aria-label="新建 Bot"
            title="新建 Bot"
            disabled={!environmentId}
            onClick={() => {
              setEditingBot(null);
              setConfigOpen(true);
            }}
          >
            <PlusIcon />
          </Button>
        </div>
      </div>

      {!botsCollapsed && searchOpen ? (
        <div className="px-2 pb-1.5">
          <input
            type="search"
            aria-label="搜索 Bot 集群"
            placeholder="搜索 Bot 或任务..."
            className="h-6.5 w-full rounded border border-sidebar-border bg-background/70 px-2 text-xs text-sidebar-foreground outline-none placeholder:text-sidebar-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
          />
        </div>
      ) : null}

      {/* Cluster Tree */}
      {!botsCollapsed ? (
        <div className="space-y-1 px-1">
          {!environmentId ? (
            <p className="px-2 py-1.5 text-2xs text-sidebar-muted-foreground">
              连接运行环境后可管理常驻 Bot 集群。
            </p>
          ) : allNodes.length === 0 ? (
            <div className="mx-1 rounded-lg border border-dashed border-sidebar-border bg-background/40 p-2.5 text-center">
              <p className="text-2xs text-sidebar-muted-foreground">尚未配置常驻协作 Bot。</p>
              <Button
                size="compact"
                variant="outline"
                className="mt-2 w-full"
                disabled={!canSeed || seeding}
                onClick={() => void handleSeedPresets()}
              >
                <PlayIcon />
                {seeding ? "初始化中..." : "加载预设集群"}
              </Button>
            </div>
          ) : (
            filteredNodes.map((node, index) => {
              const palette = BOT_ACCENT_STYLES[node.bot.accent];
              const homeKey = node.bot.homeThreadId
                ? scopedThreadKey(scopeThreadRef(environmentId, node.bot.homeThreadId))
                : null;
              const isHomeActive = homeKey !== null && homeKey === activeThreadKey;
              const isWorkerActive = node.workers.some(
                (w) => scopedThreadKey(scopeThreadRef(environmentId, w.id)) === activeThreadKey,
              );
              const expanded = isBotExpanded(node.bot.id, index, isHomeActive || isWorkerActive);
              const workingCount = node.activeWorkerCount + (node.isHomeWorking ? 1 : 0);

              return (
                <div
                  key={node.bot.id}
                  className="group rounded-lg border border-transparent bg-background/25 px-1 py-1 hover:border-sidebar-border/60"
                >
                  <div className="flex items-center gap-1.5 px-1">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded py-0.5 text-left focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      onClick={() => toggleBotExpanded(node.bot.id, expanded)}
                    >
                      <LunaBotAvatar
                        avatar={node.bot.avatar}
                        accent={node.bot.accent}
                        size="md"
                        working={workingCount > 0}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-sidebar-foreground">
                          {node.bot.name}
                        </span>
                        <span
                          className={cn(
                            "block truncate text-3xs",
                            node.needsYouCount > 0 && node.latestTask?.pendingQuestion
                              ? "text-warning-foreground"
                              : "text-sidebar-muted-foreground",
                          )}
                        >
                          {workingCount > 0
                            ? `${workingCount} 个运行中`
                            : node.needsYouCount > 0 && node.latestTask?.pendingQuestion
                              ? `待拍板: ${node.latestTask.pendingQuestion.prompt}`
                              : node.latestTask
                                ? `#${node.latestTask.number} ${node.latestTask.title}`
                                : node.bot.role}
                        </span>
                      </span>
                    </button>

                    <div className="flex shrink-0 items-center gap-1">
                      {node.needsYouCount > 0 ? (
                        <Badge size="sm" variant="warning">
                          待确认 {node.needsYouCount}
                        </Badge>
                      ) : workingCount > 0 ? (
                        <Badge size="sm" variant="info">
                          {workingCount}
                        </Badge>
                      ) : node.elapsedLabel ? (
                        <span className="font-mono text-3xs text-sidebar-muted-foreground">
                          {node.elapsedLabel}
                        </span>
                      ) : null}
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              aria-label={`进入 ${node.bot.name} 主对话`}
                              className="inline-flex size-5 cursor-pointer items-center justify-center rounded text-sidebar-muted-foreground opacity-80 transition-opacity hover:bg-sidebar-row-hover hover:text-sidebar-foreground group-hover:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                              onClick={() => void handleOpenHomeChat(node.bot)}
                            >
                              <MessageSquareIcon className="size-3" />
                            </button>
                          }
                        />
                        <TooltipPopup>直接打开主对话</TooltipPopup>
                      </Tooltip>
                      <button
                        type="button"
                        aria-label={expanded ? `收起 ${node.bot.name}` : `展开 ${node.bot.name}`}
                        className="inline-flex size-4 cursor-pointer items-center justify-center rounded text-sidebar-muted-foreground hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        onClick={() => toggleBotExpanded(node.bot.id, expanded)}
                      >
                        {expanded ? (
                          <ChevronDownIcon className="size-3" />
                        ) : (
                          <ChevronRightIcon className="size-3" />
                        )}
                      </button>
                    </div>
                  </div>

                  {expanded ? (
                    <div className="mt-1 space-y-0.5 border-l border-sidebar-border/70 pl-2.5 ml-3">
                      <button
                        type="button"
                        className={cn(
                          "flex h-6.5 w-full cursor-pointer items-center justify-between gap-2 rounded px-1.5 text-left text-2xs transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                          isHomeActive
                            ? "bg-sidebar-row-selected text-sidebar-foreground font-medium"
                            : "text-sidebar-foreground/85 hover:bg-sidebar-row-hover",
                        )}
                        onClick={() => void handleOpenHomeChat(node.bot)}
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <MessageSquareIcon className="size-3 shrink-0 opacity-75" />
                          <span className="truncate">Home Chat</span>
                        </span>
                        <span className="shrink-0 font-mono text-3xs text-sidebar-muted-foreground">
                          {node.isHomeWorking
                            ? "运行中"
                            : node.homeThread
                              ? formatBotElapsedLabel(node.homeThread.updatedAt, nowMs)
                              : "按需"}
                        </span>
                      </button>

                      {node.workers.slice(0, 5).map((worker) => {
                        const workerKey = scopedThreadKey(scopeThreadRef(environmentId, worker.id));
                        const working = isBotThreadWorking(worker);
                        return (
                          <button
                            key={worker.id}
                            type="button"
                            className={cn(
                              "flex h-6.5 w-full cursor-pointer items-center justify-between gap-2 rounded px-1.5 text-left text-2xs transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                              workerKey === activeThreadKey
                                ? "bg-sidebar-row-selected text-sidebar-foreground font-medium"
                                : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                            )}
                            onClick={() => {
                              onCloseMobileSidebar?.();
                              onNavigateToThread(scopeThreadRef(environmentId, worker.id));
                            }}
                          >
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span
                                aria-hidden
                                className={cn(
                                  "size-1.5 shrink-0 rounded-full",
                                  working ? palette.dot : "bg-success",
                                )}
                              />
                              <span className="truncate">{worker.title}</span>
                            </span>
                            <span className="shrink-0 font-mono text-3xs opacity-75">
                              {formatBotElapsedLabel(worker.updatedAt, nowMs)}
                            </span>
                          </button>
                        );
                      })}

                      <div className="flex items-center gap-1 pt-0.5">
                        <button
                          type="button"
                          className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-3xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                          onClick={() => setDispatchBotId(node.bot.id)}
                        >
                          <PlayIcon className="size-2.5" />
                          <span>派发 Worker</span>
                        </button>
                        <button
                          type="button"
                          className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-3xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                          onClick={() => {
                            setEditingBot(node.bot);
                            setConfigOpen(true);
                          }}
                        >
                          <Settings2Icon className="size-2.5" />
                          <span>配置</span>
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}

          {errorMessage ? (
            <p className="px-2 py-1 text-2xs text-destructive">{errorMessage}</p>
          ) : null}
        </div>
      ) : null}

      {environmentId ? (
        <LunaBotConfigDialog
          open={configOpen}
          environmentId={environmentId}
          initialBot={editingBot}
          onOpenChange={setConfigOpen}
        />
      ) : null}

      {environmentId && snapshot ? (
        <LunaBotDispatchDialog
          open={dispatchBotId !== null}
          environmentId={environmentId}
          bots={snapshot.bots}
          tasks={snapshot.tasks}
          defaultBotId={dispatchBotId}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setDispatchBotId(null);
          }}
          onDispatched={(threadId, targetEnvId) => {
            onCloseMobileSidebar?.();
            onNavigateToThread(scopeThreadRef(targetEnvId, threadId));
          }}
        />
      ) : null}
    </div>
  );
}
