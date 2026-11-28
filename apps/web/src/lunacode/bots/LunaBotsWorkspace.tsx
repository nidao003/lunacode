import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  extractPrShortLabel,
  formatBotElapsedLabel,
  isBotThreadWorking,
  sortBotTasks,
} from "@t3tools/client-runtime/lunacode/bots";
import {
  DEFAULT_SEED_FLOW_TEMPLATES,
  FLOW_TEMPLATES,
  type FlowStarterTemplateMeta,
  createStarterFlowSpec,
  formatFlowSpecJson,
} from "@t3tools/client-runtime/lunacode/workflow-flow";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  BotId,
  type BotTask,
  type BotTaskId,
  type BotTaskStatus,
  EnvironmentId,
  type PersistentBot,
  type ProjectId,
  type ServerProvider,
  type ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { LUNA_DEFAULT_BOT_PRESETS } from "@t3tools/shared/lunacodeBotPresets";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  AlertCircleIcon,
  BotIcon,
  CheckSquareIcon,
  FolderPlusIcon,
  LayersIcon,
  MessageSquareIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  PowerIcon,
  SearchIcon,
  Trash2Icon,
  WorkflowIcon,
} from "lucide-react";
import { useState, type FormEvent } from "react";

import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { SidebarInset } from "~/components/ui/sidebar";
import { useWorkflowEnvironmentIds } from "~/components/workflows/useWorkflowEnvironmentIds";
import { isElectron } from "~/env";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { useProjects, useQuietThreadShells } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { BOT_TASK_STATUS_META, LunaBotAvatar, extractBotErrorMessage } from "./LunaBotAvatar";
import { LunaBotConfigDialog } from "./LunaBotConfigDialog";
import { LunaBotDispatchDialog } from "./LunaBotDispatchDialog";
import { LunaBotTaskDetailPanel } from "./LunaBotTaskDetailPanel";

const EMPTY_PROVIDERS_ATOM = Atom.make<ReadonlyArray<ServerProvider> | null>(null);

export type BotsHubTab = "tasks" | "bots" | "automations";

export interface BotsSearch {
  readonly env?: string;
  readonly bot?: string;
  readonly task?: string;
  readonly tab?: BotsHubTab;
}

function QuickNewTaskBar({
  environmentId,
  bots,
  defaultBotId,
  canOperate,
  onCreated,
  onCancel,
}: {
  readonly environmentId: EnvironmentId;
  readonly bots: ReadonlyArray<PersistentBot>;
  readonly defaultBotId: string;
  readonly canOperate: boolean;
  readonly onCreated: (task: BotTask) => void;
  readonly onCancel: () => void;
}) {
  const upsertTask = useAtomCommand(serverEnvironment.upsertBotTask, {
    label: "hub create bot task",
    reportFailure: false,
  });
  const [botId, setBotId] = useState(defaultBotId || bots[0]?.id || "");
  const [title, setTitle] = useState("");
  const [doneMeans, setDoneMeans] = useState("");
  const [saving, setSaving] = useState(false);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle || !botId || !canOperate || saving) return;
    setSaving(true);
    const result = await upsertTask({
      environmentId,
      input: {
        botId: BotId.make(botId),
        title: TrimmedNonEmptyString.make(cleanTitle),
        doneMeans: doneMeans.trim() || null,
        status: "backlog",
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      onCreated(result.value);
    }
  };

  return (
    <form
      onSubmit={(event) => void handleCreate(event)}
      className="rounded-xl border border-border bg-card p-3 space-y-2.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="选择负责 Bot"
          className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          value={botId}
          onChange={(event) => setBotId(event.target.value)}
        >
          {bots.map((bot) => (
            <option key={bot.id} value={bot.id}>
              {bot.name} (@{bot.handle})
            </option>
          ))}
        </select>
        <input
          type="text"
          aria-label="新任务标题"
          placeholder="任务标题，例如: 排查 Safari 支付按钮首次点击失效"
          className="h-8 min-w-[200px] flex-1 rounded-md border border-input bg-background px-2.5 text-xs text-foreground outline-none placeholder:text-placeholder focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          aria-label="完成标准"
          placeholder="Done means (完成标准，可选)"
          className="h-8 min-w-[200px] flex-1 rounded-md border border-input bg-background px-2.5 text-xs text-foreground outline-none placeholder:text-placeholder focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25"
          value={doneMeans}
          onChange={(event) => setDoneMeans(event.target.value)}
        />
        <Button type="button" size="compact" variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" size="compact" disabled={!canOperate || !title.trim() || saving}>
          {saving ? "创建中..." : "创建任务卡"}
        </Button>
      </div>
    </form>
  );
}

export function LunaBotsWorkspace() {
  const search = useSearch({ from: "/_chat/bots" });
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  const askedEnvId = search.env ? EnvironmentId.make(search.env) : null;
  const environmentId =
    (askedEnvId && environments.some((env) => env.environmentId === askedEnvId)
      ? askedEnvId
      : (primaryEnvironmentId ?? environments[0]?.environmentId)) ?? null;

  const botsQuery = useEnvironmentQuery(
    environmentId ? serverEnvironment.botsLive({ environmentId, input: {} }) : null,
  );
  const workflowEnvIds = useWorkflowEnvironmentIds();
  const workflowsEnabled = Boolean(environmentId && workflowEnvIds.includes(environmentId));
  const workflowDefsQuery = useEnvironmentQuery(
    workflowsEnabled && environmentId
      ? serverEnvironment.workflowDefinition({ environmentId, input: {} })
      : null,
  );
  const snapshot = botsQuery.data;
  const allThreads = useQuietThreadShells();
  const allProjects = useProjects();
  const providers =
    useAtomValue(
      environmentId ? serverEnvironment.providersValueAtom(environmentId) : EMPTY_PROVIDERS_ATOM,
    ) ?? [];
  const nowMinuteIso = useNowMinute();
  const parsedNow = Date.parse(nowMinuteIso);
  const nowMs = Number.isNaN(parsedNow) ? 0 : parsedNow;

  const canSeed = useAtomValue(serverEnvironment.seedBotPresets.permissionAtom(environmentId));
  const canOperateTask = useAtomValue(
    serverEnvironment.upsertBotTask.permissionAtom(environmentId),
  );
  const canEnsureHome = useAtomValue(
    serverEnvironment.ensureBotHomeThread.permissionAtom(environmentId),
  );
  const canDeleteBot = useAtomValue(serverEnvironment.deleteBot.permissionAtom(environmentId));
  const canUpdateSettings = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(environmentId),
  );
  const canSaveWorkflow = useAtomValue(
    serverEnvironment.saveWorkflowDefinition.permissionAtom(environmentId),
  );
  const canStartWorkflow = useAtomValue(
    serverEnvironment.startWorkflowRun.permissionAtom(environmentId),
  );

  const seedPresets = useAtomCommand(serverEnvironment.seedBotPresets, {
    label: "hub seed bot presets",
    reportFailure: false,
  });
  const ensureHome = useAtomCommand(serverEnvironment.ensureBotHomeThread, {
    label: "hub ensure home thread",
    reportFailure: false,
  });
  const deleteBot = useAtomCommand(serverEnvironment.deleteBot, {
    label: "hub delete bot",
    reportFailure: false,
  });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "hub enable workflows",
    reportFailure: false,
  });
  const saveWorkflow = useAtomCommand(serverEnvironment.saveWorkflowDefinition, {
    label: "hub save workflow template",
    reportFailure: false,
  });
  const startWorkflow = useAtomCommand(serverEnvironment.startWorkflowRun, {
    label: "hub start workflow",
    reportFailure: false,
  });

  const activeTab: BotsHubTab = search.tab ?? "tasks";
  const [statusFilter, setStatusFilter] = useState<BotTaskStatus | "all">("all");
  const [botFilterId, setBotFilterId] = useState<string>(search.bot ?? "all");
  const [queryText, setQueryText] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(search.task ?? null);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [editingBot, setEditingBot] = useState<PersistentBot | null>(null);
  const [dispatchState, setDispatchState] = useState<{
    readonly open: boolean;
    readonly botId: BotId | null;
    readonly taskId: BotTaskId | null;
  }>({ open: false, botId: null, taskId: null });
  const [actionError, setActionError] = useState<string | null>(null);
  const [enablingWorkflows, setEnablingWorkflows] = useState(false);
  const [seedingFlows, setSeedingFlows] = useState(false);
  const [creatingFlowId, setCreatingFlowId] = useState<string | null>(null);
  const [startingWorkflowName, setStartingWorkflowName] = useState<string | null>(null);

  const threadsById = new Map<ThreadId, EnvironmentThreadShell>();
  const projectsById = new Map<ProjectId, EnvironmentProject>();
  if (environmentId) {
    for (const thread of allThreads) {
      if (thread.environmentId === environmentId && thread.deletedAt === null) {
        threadsById.set(thread.id, thread);
      }
    }
    for (const project of allProjects) {
      if (project.environmentId === environmentId) {
        projectsById.set(project.id, project);
      }
    }
  }

  const bots = snapshot?.bots.filter((bot) => bot.archived !== true) ?? [];
  const botsById = new Map(bots.map((bot) => [bot.id, bot]));
  const missingPresetCount = LUNA_DEFAULT_BOT_PRESETS.filter(
    (preset) =>
      !bots.some(
        (bot) => bot.id === preset.id || bot.handle.toLowerCase() === preset.handle.toLowerCase(),
      ),
  ).length;
  const existingFlowFiles = new Set(
    (workflowDefsQuery.data?.files ?? []).map((f) => f.name.toLowerCase()),
  );
  const missingDefaultFlows = DEFAULT_SEED_FLOW_TEMPLATES.filter(
    (item) => !existingFlowFiles.has(item.defaultFileName.toLowerCase()),
  );
  const envProjects = environmentId
    ? allProjects.filter((p) => p.environmentId === environmentId)
    : [];
  const sortedTasks = snapshot ? sortBotTasks(snapshot.tasks) : [];

  const normalizedQuery = queryText.trim().toLowerCase();
  const filteredTasks = sortedTasks.filter((task) => {
    if (statusFilter !== "all" && task.status !== statusFilter) return false;
    if (botFilterId !== "all" && task.botId !== botFilterId) return false;
    if (normalizedQuery) {
      const bot = botsById.get(task.botId);
      const matches =
        task.title.toLowerCase().includes(normalizedQuery) ||
        `#${task.number}`.includes(normalizedQuery) ||
        (task.doneMeans?.toLowerCase().includes(normalizedQuery) ?? false) ||
        (bot?.name.toLowerCase().includes(normalizedQuery) ?? false);
      if (!matches) return false;
    }
    return true;
  });

  const resolvedTask =
    (selectedTaskId ? filteredTasks.find((t) => t.id === selectedTaskId) : undefined) ??
    filteredTasks[0] ??
    null;
  const resolvedBot =
    (resolvedTask ? botsById.get(resolvedTask.botId) : undefined) ??
    (botFilterId !== "all" ? botsById.get(BotId.make(botFilterId)) : undefined) ??
    bots[0] ??
    null;

  const setTab = (nextTab: BotsHubTab) => {
    void navigate({
      to: "/bots",
      search: {
        ...(environmentId ? { env: environmentId } : {}),
        ...(botFilterId !== "all" ? { bot: botFilterId } : {}),
        tab: nextTab,
      },
      replace: true,
    });
  };

  const handleOpenThread = (threadId: ThreadId) => {
    if (!environmentId) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
  };

  const handleEnsureHome = async (bot: PersistentBot) => {
    if (!environmentId) return;
    if (bot.homeThreadId) {
      handleOpenThread(bot.homeThreadId);
      return;
    }
    if (!canEnsureHome) return;
    setActionError(null);
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
      setActionError(extractBotErrorMessage(squashAtomCommandFailure(result)));
    }
  };

  const handleSeed = async () => {
    if (!environmentId || !canSeed) return;
    setActionError(null);
    const result = await seedPresets({ environmentId, input: {} });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setActionError(extractBotErrorMessage(squashAtomCommandFailure(result)));
    }
  };

  const handleDeleteBot = async (bot: PersistentBot) => {
    if (!environmentId || !canDeleteBot) return;
    const confirmed = window.confirm(
      `确认停用并移除常驻 Bot「${bot.name}」吗？历史线程不会被删除。`,
    );
    if (!confirmed) return;
    setActionError(null);
    const result = await deleteBot({ environmentId, input: { botId: bot.id } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setActionError(extractBotErrorMessage(squashAtomCommandFailure(result)));
    }
  };

  const resolveTemplateCreationOpts = () => {
    const defaultProvider = providers.find((p) => p.enabled && p.models.length > 0);
    const defaultModel =
      defaultProvider?.models.find((m) => m.isDefault) ?? defaultProvider?.models[0];
    return {
      ...(envProjects[0]?.id ? { project: envProjects[0].id } : {}),
      ...(defaultProvider?.instanceId ? { providerInstanceId: defaultProvider.instanceId } : {}),
      ...(defaultModel?.slug ? { model: defaultModel.slug } : {}),
    };
  };

  const handleEnableWorkflows = async () => {
    if (!environmentId || !canUpdateSettings || enablingWorkflows) return;
    setEnablingWorkflows(true);
    setActionError(null);
    const result = await updateSettings({
      environmentId,
      input: { patch: { workflowsEnabled: true } },
    });
    setEnablingWorkflows(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setActionError(extractBotErrorMessage(squashAtomCommandFailure(result)));
    }
  };

  const handleSeedDefaultFlows = async () => {
    if (!environmentId || !canSaveWorkflow || seedingFlows || missingDefaultFlows.length === 0) {
      return;
    }
    setSeedingFlows(true);
    setActionError(null);
    const opts = resolveTemplateCreationOpts();
    for (const item of missingDefaultFlows) {
      const spec = createStarterFlowSpec({
        name: item.defaultFileName.replace(/\.flow\.json$/i, ""),
        template: item.id,
        ...opts,
      });
      const result = await saveWorkflow({
        environmentId,
        input: { name: item.defaultFileName, source: formatFlowSpecJson(spec) },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        setActionError(extractBotErrorMessage(squashAtomCommandFailure(result)));
        break;
      }
    }
    setSeedingFlows(false);
  };

  const handleCreateTemplateFlow = async (item: FlowStarterTemplateMeta) => {
    if (!environmentId || !canSaveWorkflow || creatingFlowId !== null) return;
    setCreatingFlowId(item.id);
    setActionError(null);
    const spec = createStarterFlowSpec({
      name: item.defaultFileName.replace(/\.flow\.json$/i, ""),
      template: item.id,
      ...resolveTemplateCreationOpts(),
    });
    const result = await saveWorkflow({
      environmentId,
      input: { name: item.defaultFileName, source: formatFlowSpecJson(spec) },
    });
    setCreatingFlowId(null);
    if (result._tag === "Success") {
      void navigate({
        to: "/workflows",
        search: { env: environmentId, definitions: true, file: item.defaultFileName },
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setActionError(extractBotErrorMessage(squashAtomCommandFailure(result)));
    }
  };

  const handleStartWorkflow = async (workflowName: string) => {
    if (!environmentId || !canStartWorkflow || startingWorkflowName !== null) return;
    setStartingWorkflowName(workflowName);
    setActionError(null);
    const result = await startWorkflow({
      environmentId,
      input: { workflow: workflowName },
    });
    setStartingWorkflowName(null);
    if (result._tag === "Success") {
      void navigate({
        to: "/workflows",
        search: { env: environmentId, run: result.value.runId },
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setActionError(extractBotErrorMessage(squashAtomCommandFailure(result)));
    }
  };

  const needsYouCount = sortedTasks.filter(
    (task) => task.status === "needs_you" || task.pendingQuestion !== null,
  ).length;

  return (
    <SidebarInset className="flex min-h-0 flex-1 flex-col">
      <WorkspacePageHeader electron={isElectron}>
        <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <BotIcon className="size-4.5 shrink-0 text-primary" />
            <h1 className="truncate text-sm font-semibold text-foreground">
              常驻 Bot 集群与任务中心
            </h1>
            {needsYouCount > 0 ? (
              <Badge size="sm" variant="warning">
                {needsYouCount} 项待拍板
              </Badge>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {environments.length > 1 ? (
              <select
                aria-label="切换运行环境"
                className="h-7.5 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                value={environmentId ?? ""}
                onChange={(event) => {
                  void navigate({
                    to: "/bots",
                    search: { env: event.target.value, tab: activeTab },
                  });
                }}
              >
                {environments.map((env) => (
                  <option key={env.environmentId} value={env.environmentId}>
                    {env.label}
                  </option>
                ))}
              </select>
            ) : null}
            <Button
              size="compact"
              variant="outline"
              disabled={!environmentId || bots.length === 0}
              onClick={() =>
                setDispatchState({
                  open: true,
                  botId: resolvedBot?.id ?? bots[0]?.id ?? null,
                  taskId: resolvedTask?.id ?? null,
                })
              }
            >
              <PlayIcon />
              派发 Worker
            </Button>
            <Button
              size="compact"
              disabled={!environmentId}
              onClick={() => {
                setEditingBot(null);
                setConfigOpen(true);
              }}
            >
              <PlusIcon />
              新建 Bot
            </Button>
          </div>
        </div>
      </WorkspacePageHeader>

      {/* Segmented Navigation Bar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2 sm:px-6">
        <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-1">
          <button
            type="button"
            className={cn(
              "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              activeTab === "tasks"
                ? "bg-card text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setTab("tasks")}
          >
            <CheckSquareIcon className="size-3.5" />
            <span>任务看板 ({sortedTasks.length})</span>
          </button>
          <button
            type="button"
            className={cn(
              "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              activeTab === "bots"
                ? "bg-card text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setTab("bots")}
          >
            <BotIcon className="size-3.5" />
            <span>Bot 集群 ({bots.length})</span>
          </button>
          <button
            type="button"
            className={cn(
              "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              activeTab === "automations"
                ? "bg-card text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setTab("automations")}
          >
            <WorkflowIcon className="size-3.5" />
            <span>自动化联动</span>
          </button>
        </div>

        {actionError ? (
          <div className="flex items-center gap-1.5 text-xs text-destructive">
            <AlertCircleIcon className="size-3.5" />
            <span>{actionError}</span>
          </div>
        ) : null}
      </div>

      {!environmentId ? (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          请先连接至少一个运行环境。
        </div>
      ) : bots.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="max-w-md rounded-2xl border border-dashed border-border bg-card/50 p-6 text-center space-y-3">
            <BotIcon className="mx-auto size-8 text-primary" />
            <h2 className="text-base font-semibold text-foreground">启动你的常驻 Bot 集群</h2>
            <p className="text-xs leading-relaxed text-muted-foreground">
              每个 Bot 拥有长期记忆主对话 (Home Chat)、独立 Worktree 并行 Worker
              线程，以及跨工作流共享的持久化任务卡 (#1, #2...)。按需加载，不触发任何隐式 Token
              消耗。
            </p>
            <div className="flex flex-wrap justify-center gap-2 pt-2">
              <Button disabled={!canSeed} onClick={() => void handleSeed()}>
                <PlayIcon />
                一键加载 6 位常驻 Bot
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setEditingBot(null);
                  setConfigOpen(true);
                }}
              >
                <PlusIcon />
                从空白新建 Bot
              </Button>
            </div>
          </div>
        </div>
      ) : activeTab === "tasks" ? (
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          {/* Left / Main Task Board */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {/* Filters & New Task Trigger */}
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5 sm:px-6">
              <div className="flex flex-wrap items-center gap-1.5">
                {(["all", "needs_you", "in_progress", "backlog", "done"] as const).map((status) => (
                  <button
                    key={status}
                    type="button"
                    className={cn(
                      "cursor-pointer rounded-md border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      statusFilter === status
                        ? "border-primary/40 bg-primary/10 text-foreground"
                        : "border-border bg-background text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => setStatusFilter(status)}
                  >
                    {status === "all" ? "全部" : BOT_TASK_STATUS_META[status].label}
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="按 Bot 筛选任务"
                  className="h-7.5 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  value={botFilterId}
                  onChange={(event) => setBotFilterId(event.target.value)}
                >
                  <option value="all">全部 Bots</option>
                  {bots.map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {bot.name}
                    </option>
                  ))}
                </select>
                <div className="relative">
                  <SearchIcon className="pointer-events-none absolute top-2 left-2 size-3.5 text-muted-foreground" />
                  <input
                    type="search"
                    aria-label="搜索任务"
                    placeholder="搜索 #编号 或标题..."
                    className="h-7.5 w-44 rounded-md border border-input bg-background pr-2.5 pl-7 text-xs text-foreground outline-none placeholder:text-placeholder focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25"
                    value={queryText}
                    onChange={(event) => setQueryText(event.target.value)}
                  />
                </div>
                <Button
                  size="compact"
                  variant="outline"
                  disabled={!canOperateTask}
                  onClick={() => setNewTaskOpen((prev) => !prev)}
                >
                  <PlusIcon />
                  新建任务
                </Button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6 space-y-3">
              {newTaskOpen ? (
                <QuickNewTaskBar
                  environmentId={environmentId}
                  bots={bots}
                  defaultBotId={botFilterId !== "all" ? botFilterId : (bots[0]?.id ?? "")}
                  canOperate={canOperateTask}
                  onCreated={(created) => {
                    setNewTaskOpen(false);
                    setSelectedTaskId(created.id);
                  }}
                  onCancel={() => setNewTaskOpen(false)}
                />
              ) : null}

              {filteredTasks.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border p-8 text-center text-xs text-muted-foreground">
                  当前筛选条件下暂无任务。可点击上方「新建任务」或给任意 Bot 派发 Worker 自动建卡。
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredTasks.map((task) => {
                    const owner = botsById.get(task.botId);
                    const isSelected = resolvedTask?.id === task.id;
                    const activeWorkers = task.workerThreadIds.filter((tid) =>
                      isBotThreadWorking(threadsById.get(tid)),
                    ).length;

                    return (
                      <button
                        key={task.id}
                        type="button"
                        className={cn(
                          "w-full cursor-pointer rounded-xl border p-3.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                          isSelected
                            ? "border-primary/50 bg-accent/40"
                            : "border-border bg-card/50 hover:bg-accent/25",
                        )}
                        onClick={() => setSelectedTaskId(task.id)}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-start gap-2.5">
                            {owner ? (
                              <LunaBotAvatar
                                avatar={owner.avatar}
                                accent={owner.accent}
                                size="sm"
                                working={activeWorkers > 0}
                              />
                            ) : null}
                            <div className="min-w-0 space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono text-xs text-muted-foreground">
                                  #{task.number}
                                </span>
                                <span className="font-medium text-sm text-foreground">
                                  {task.title}
                                </span>
                                <Badge
                                  size="sm"
                                  variant={BOT_TASK_STATUS_META[task.status].badgeVariant}
                                >
                                  {BOT_TASK_STATUS_META[task.status].label}
                                </Badge>
                              </div>
                              {task.doneMeans ? (
                                <p className="line-clamp-1 text-xs text-muted-foreground">
                                  Done means: {task.doneMeans}
                                </p>
                              ) : null}
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-2 text-2xs text-muted-foreground">
                            {task.linkedPrUrls.slice(0, 1).map((url) => (
                              <Badge key={url} size="sm" variant="success">
                                <PullRequestGlyph.pullRequest className="size-3" />
                                {extractPrShortLabel(url)}
                              </Badge>
                            ))}
                            {task.workerThreadIds.length > 0 ? (
                              <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-3xs">
                                <LayersIcon className="size-2.5" />
                                {task.workerThreadIds.length}
                              </span>
                            ) : null}
                            <span className="font-mono">
                              {formatBotElapsedLabel(task.updatedAt, nowMs)}
                            </span>
                          </div>
                        </div>

                        {task.pendingQuestion ? (
                          <div className="mt-2.5 rounded-lg border border-warning/35 bg-warning/10 px-2.5 py-1.5 text-xs text-foreground">
                            <span className="font-semibold text-warning-foreground">待拍板: </span>
                            {task.pendingQuestion.prompt}
                          </div>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right Task Detail Inspector */}
          {resolvedBot ? (
            <div className="h-[460px] shrink-0 border-t border-border lg:h-auto lg:w-[380px] lg:border-t-0 lg:border-l">
              <LunaBotTaskDetailPanel
                environmentId={environmentId}
                bot={resolvedBot}
                task={resolvedTask}
                allTasksForBot={sortedTasks.filter((item) => item.botId === resolvedBot.id)}
                threadsById={threadsById}
                projectsById={projectsById}
                nowMs={nowMs}
                onSelectTask={(taskId) => setSelectedTaskId(taskId)}
                onOpenThread={handleOpenThread}
                onEnsureHomeThread={(bot) => void handleEnsureHome(bot)}
                onDispatchWorker={(bot, task) =>
                  setDispatchState({
                    open: true,
                    botId: bot.id,
                    taskId: task?.id ?? null,
                  })
                }
                onOpenNewTask={() => setNewTaskOpen(true)}
              />
            </div>
          ) : null}
        </div>
      ) : activeTab === "bots" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          {missingPresetCount > 0 ? (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-border bg-card/60 px-4 py-2.5 text-xs">
              <span className="text-muted-foreground">
                默认协作团队还有 {missingPresetCount} 位推荐成员未加入当前集群。
              </span>
              <Button
                size="compact"
                variant="outline"
                disabled={!canSeed}
                onClick={() => void handleSeed()}
              >
                <FolderPlusIcon />
                补齐默认团队 (+{missingPresetCount})
              </Button>
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {bots.map((bot) => {
              const botTasks = sortedTasks.filter((task) => task.botId === bot.id);
              const openCount = botTasks.filter(
                (t) => t.status !== "done" && t.status !== "cancelled",
              ).length;
              const needsCount = botTasks.filter((t) => t.status === "needs_you").length;
              return (
                <div
                  key={bot.id}
                  className="flex flex-col justify-between gap-4 rounded-xl border border-border bg-card p-4"
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <LunaBotAvatar avatar={bot.avatar} accent={bot.accent} size="lg" />
                        <div className="min-w-0">
                          <h3 className="truncate text-sm font-semibold text-foreground">
                            {bot.name}
                          </h3>
                          <p className="truncate font-mono text-xs text-muted-foreground">
                            @{bot.handle} · {bot.role}
                          </p>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {needsCount > 0 ? (
                          <Badge size="sm" variant="warning">
                            {needsCount} 待确认
                          </Badge>
                        ) : null}
                        <Badge size="sm" variant="outline">
                          {openCount} 进行中
                        </Badge>
                      </div>
                    </div>

                    <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                      {bot.systemPrompt || "通用协作职责"}
                    </p>

                    <div className="flex flex-wrap gap-1.5 text-2xs">
                      <Badge size="sm" variant="outline">
                        {bot.workspaceStrategy === "worktree" ? "Worktree 并行" : "项目根目录"}
                      </Badge>
                      {bot.model ? (
                        <Badge size="sm" variant="info">
                          {bot.model}
                        </Badge>
                      ) : null}
                      {bot.linkedWorkflowNames.map((name) => (
                        <Badge key={name} size="sm" variant="success">
                          {name}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-3">
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="compact"
                        variant="outline"
                        onClick={() => void handleEnsureHome(bot)}
                      >
                        <MessageSquareIcon />
                        {bot.homeThreadId ? "Home Chat" : "初始化对话"}
                      </Button>
                      <Button
                        size="compact"
                        onClick={() =>
                          setDispatchState({ open: true, botId: bot.id, taskId: null })
                        }
                      >
                        <PlayIcon />
                        派发
                      </Button>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`编辑 ${bot.name}`}
                        onClick={() => {
                          setEditingBot(bot);
                          setConfigOpen(true);
                        }}
                      >
                        <PencilIcon />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost-destructive"
                        aria-label={`删除 ${bot.name}`}
                        disabled={!canDeleteBot}
                        onClick={() => void handleDeleteBot(bot)}
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="mx-auto max-w-4xl space-y-5">
            {!workflowsEnabled ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning/10 p-4 text-xs">
                <div className="space-y-0.5">
                  <p className="font-semibold text-foreground">自动化工作流引擎当前处于关闭状态</p>
                  <p className="text-muted-foreground">
                    默认保持关闭、零后台 Token 消耗。开启后可查看并运行预置的 6 套 `.flow.json`
                    案例并与 Bot 联动。
                  </p>
                </div>
                <Button
                  size="compact"
                  disabled={!canUpdateSettings || enablingWorkflows}
                  onClick={() => void handleEnableWorkflows()}
                >
                  <PowerIcon />
                  {enablingWorkflows ? "开启中..." : "开启工作流引擎"}
                </Button>
              </div>
            ) : null}

            <div className="rounded-xl border border-border bg-card p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-foreground">
                    Bot 集群与可视化工作流联动
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    每位常驻 Bot 可绑定多个 LUNA-020 `.flow.json`
                    工作流与触发器，点击即可运行或进入画布编辑。
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {workflowsEnabled && missingDefaultFlows.length > 0 ? (
                    <Button
                      size="compact"
                      variant="outline"
                      disabled={!canSaveWorkflow || seedingFlows}
                      onClick={() => void handleSeedDefaultFlows()}
                    >
                      <FolderPlusIcon />
                      {seedingFlows ? "导入中..." : `补齐默认案例 (+${missingDefaultFlows.length})`}
                    </Button>
                  ) : null}
                  <Link to="/workflows" search={{ env: environmentId }}>
                    <Button size="compact">
                      <WorkflowIcon />
                      打开工作流编排
                    </Button>
                  </Link>
                </div>
              </div>
              <div className="space-y-2 pt-2">
                {bots.map((bot) => (
                  <div
                    key={bot.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-background/60 px-3 py-2 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <LunaBotAvatar avatar={bot.avatar} accent={bot.accent} size="sm" />
                      <span className="font-medium text-foreground">{bot.name}</span>
                      <span className="font-mono text-muted-foreground">@{bot.handle}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {bot.linkedWorkflowNames.length > 0 ? (
                        bot.linkedWorkflowNames.map((wf) => (
                          <div
                            key={wf}
                            className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-0.5"
                          >
                            <span className="font-mono text-2xs text-foreground">{wf}</span>
                            {workflowsEnabled ? (
                              <>
                                <button
                                  type="button"
                                  disabled={!canStartWorkflow || startingWorkflowName !== null}
                                  className="cursor-pointer rounded px-1 py-0.5 text-3xs font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
                                  onClick={() => void handleStartWorkflow(wf)}
                                >
                                  {startingWorkflowName === wf ? "..." : "运行"}
                                </button>
                                <Link
                                  to="/workflows"
                                  search={{
                                    env: environmentId,
                                    definitions: true,
                                    file: `${wf}.flow.json`,
                                  }}
                                  className="rounded px-1 py-0.5 text-3xs text-muted-foreground hover:bg-accent hover:text-foreground"
                                >
                                  画布
                                </Link>
                              </>
                            ) : null}
                          </div>
                        ))
                      ) : (
                        <span className="text-muted-foreground">未绑定工作流</span>
                      )}
                      <Button
                        size="micro"
                        variant="ghost"
                        onClick={() => {
                          setEditingBot(bot);
                          setConfigOpen(true);
                        }}
                      >
                        配置绑定
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-border bg-card p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-foreground">
                    精选可视化工作流案例库（共 {FLOW_TEMPLATES.length} 套）
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    融合 Orca 多代理分工与 GitHub Agentic Workflows (gh-aw)
                    最佳实践，默认触发器均为按需手动运行，绝不隐式消耗 Token。
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {FLOW_TEMPLATES.map((item) => {
                  const exists = existingFlowFiles.has(item.defaultFileName.toLowerCase());
                  return (
                    <div
                      key={item.id}
                      className="flex flex-col justify-between gap-3 rounded-xl border border-border bg-background/60 p-3.5 text-xs"
                    >
                      <div className="space-y-1.5">
                        <div className="flex flex-wrap items-center justify-between gap-1.5">
                          <span className="font-semibold text-foreground">{item.label}</span>
                          <div className="flex items-center gap-1">
                            <Badge size="sm" variant="outline">
                              {item.category}
                            </Badge>
                            <Badge size="sm" variant="info">
                              @{item.recommendedBotHandle}
                            </Badge>
                          </div>
                        </div>
                        <p className="font-mono text-3xs text-muted-foreground">
                          {item.defaultFileName} · {item.recommendedTriggerHint}
                        </p>
                        <p className="leading-relaxed text-muted-foreground">{item.description}</p>
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-1.5 pt-1">
                        {exists ? (
                          <Link
                            to="/workflows"
                            search={{
                              env: environmentId,
                              definitions: true,
                              file: item.defaultFileName,
                            }}
                          >
                            <Button size="micro" variant="outline">
                              打开画布
                            </Button>
                          </Link>
                        ) : (
                          <Button
                            size="micro"
                            variant="outline"
                            disabled={
                              !workflowsEnabled || !canSaveWorkflow || creatingFlowId !== null
                            }
                            onClick={() => void handleCreateTemplateFlow(item)}
                          >
                            {creatingFlowId === item.id ? "创建中..." : "一键创建"}
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

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
          open={dispatchState.open}
          environmentId={environmentId}
          bots={snapshot.bots}
          tasks={snapshot.tasks}
          defaultBotId={dispatchState.botId}
          defaultTaskId={dispatchState.taskId}
          onOpenChange={(open) => setDispatchState((prev) => ({ ...prev, open }))}
          onDispatched={(threadId) => handleOpenThread(threadId)}
        />
      ) : null}
    </SidebarInset>
  );
}
