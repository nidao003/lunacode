import {
  extractPrShortLabel,
  formatBotElapsedLabel,
  isBotThreadWorking,
} from "@t3tools/client-runtime/lunacode/bots";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type BotTask,
  type BotTaskId,
  type BotTaskStatus,
  type EnvironmentId,
  type PersistentBot,
  type ProjectId,
  type ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  LayersIcon,
  MessageCircleIcon,
  MessageSquarePlusIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SendIcon,
  WorkflowIcon,
} from "lucide-react";
import { useState, type FormEvent } from "react";

import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  BOT_ACCENT_STYLES,
  BOT_TASK_STATUS_META,
  LunaBotAvatar,
  extractBotErrorMessage,
} from "./LunaBotAvatar";

type InspectorTab = "task" | "connectors" | "chats";

function DoneMeansEditor({
  environmentId,
  task,
  canOperate,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: BotTask;
  readonly canOperate: boolean;
  readonly onDone: () => void;
}) {
  const upsertTask = useAtomCommand(serverEnvironment.upsertBotTask, {
    label: "bot task doneMeans",
    reportFailure: false,
  });
  const [draft, setDraft] = useState(task.doneMeans ?? "");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (saving || !canOperate) return;
    setSaving(true);
    await upsertTask({
      environmentId,
      input: {
        id: task.id,
        botId: task.botId,
        title: task.title,
        doneMeans: draft.trim() || null,
      },
    });
    setSaving(false);
    onDone();
  };

  return (
    <div className="space-y-1.5">
      <textarea
        rows={2}
        className="w-full rounded-md border border-input bg-background p-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25"
        value={draft}
        placeholder="描述任务完成的客观验收标准..."
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="flex justify-end gap-1.5">
        <Button size="compact" variant="ghost" onClick={onDone}>
          取消
        </Button>
        <Button size="compact" disabled={!canOperate || saving} onClick={() => void handleSave()}>
          {saving ? "保存中..." : "保存"}
        </Button>
      </div>
    </div>
  );
}

function safeExternalUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

export function LunaBotTaskDetailPanel({
  environmentId,
  bot,
  task,
  allTasksForBot,
  threadsById,
  projectsById,
  nowMs,
  onSelectTask,
  onBackToAllTasks,
  onOpenThread,
  onEnsureHomeThread,
  onDispatchWorker,
  onOpenNewTask,
  showBackButton = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: PersistentBot;
  readonly task: BotTask | null;
  readonly allTasksForBot: ReadonlyArray<BotTask>;
  readonly threadsById: ReadonlyMap<ThreadId, EnvironmentThreadShell>;
  readonly projectsById: ReadonlyMap<ProjectId, EnvironmentProject>;
  readonly nowMs: number;
  readonly onSelectTask?: (taskId: BotTaskId) => void;
  readonly onBackToAllTasks?: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onEnsureHomeThread: (bot: PersistentBot) => void;
  readonly onDispatchWorker: (bot: PersistentBot, task: BotTask | null) => void;
  readonly onOpenNewTask?: (bot: PersistentBot) => void;
  readonly showBackButton?: boolean;
}) {
  const navigate = useNavigate();
  const canOperate = useAtomValue(serverEnvironment.upsertBotTask.permissionAtom(environmentId));
  const canComment = useAtomValue(serverEnvironment.commentBotTask.permissionAtom(environmentId));
  const canAnswer = useAtomValue(serverEnvironment.answerBotTask.permissionAtom(environmentId));

  const upsertTask = useAtomCommand(serverEnvironment.upsertBotTask, {
    label: "bot task status",
    reportFailure: false,
  });
  const commentTask = useAtomCommand(serverEnvironment.commentBotTask, {
    label: "bot task comment",
    reportFailure: false,
  });
  const answerTask = useAtomCommand(serverEnvironment.answerBotTask, {
    label: "bot task answer",
    reportFailure: false,
  });

  const [tab, setTab] = useState<InspectorTab>("task");
  const [editingDoneMeansForTaskId, setEditingDoneMeansForTaskId] = useState<string | null>(null);
  const [answerReason, setAnswerReason] = useState("");
  const [answering, setAnswering] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [notifyBot, setNotifyBot] = useState(true);
  const [commenting, setCommenting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const botAccent = BOT_ACCENT_STYLES[bot.accent];
  const project =
    (task?.projectId ? projectsById.get(task.projectId) : undefined) ??
    (bot.defaultProjectId ? projectsById.get(bot.defaultProjectId) : undefined) ??
    null;

  const handleStatusChange = async (nextStatus: BotTaskStatus) => {
    if (!task || !canOperate) return;
    setActionError(null);
    const result = await upsertTask({
      environmentId,
      input: {
        id: task.id,
        botId: task.botId,
        title: task.title,
        status: nextStatus,
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setActionError(extractBotErrorMessage(squashAtomCommandFailure(result)));
    }
  };

  const handleAnswerChoice = async (choice: string) => {
    if (!task || !canAnswer || answering) return;
    setAnswering(true);
    setActionError(null);
    const result = await answerTask({
      environmentId,
      input: {
        taskId: task.id,
        choice: TrimmedNonEmptyString.make(choice),
        ...(answerReason.trim() ? { reason: answerReason.trim() } : {}),
      },
    });
    setAnswering(false);
    if (result._tag === "Success") {
      setAnswerReason("");
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setActionError(extractBotErrorMessage(squashAtomCommandFailure(result)));
    }
  };

  const handleCommentSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!task || !canComment || commenting) return;
    const trimmed = commentText.trim();
    if (!trimmed) return;
    setCommenting(true);
    setActionError(null);
    const result = await commentTask({
      environmentId,
      input: {
        taskId: task.id,
        text: TrimmedNonEmptyString.make(trimmed),
        notifyBot,
      },
    });
    setCommenting(false);
    if (result._tag === "Success") {
      setCommentText("");
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setActionError(extractBotErrorMessage(squashAtomCommandFailure(result)));
    }
  };

  const allBotWorkerIds = new Set<ThreadId>();
  for (const item of allTasksForBot) {
    for (const tid of item.workerThreadIds) {
      allBotWorkerIds.add(tid);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-card/30 text-foreground">
      {/* Top Bar: Tabs matching Orca Inspector */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={cn(
              "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              tab === "task"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setTab("task")}
          >
            <LayersIcon className="size-3.5" />
            <span>任务</span>
          </button>
          <button
            type="button"
            className={cn(
              "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              tab === "connectors"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setTab("connectors")}
          >
            <WorkflowIcon className="size-3.5" />
            <span>关联</span>
          </button>
          <button
            type="button"
            className={cn(
              "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              tab === "chats"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setTab("chats")}
          >
            <MessageCircleIcon className="size-3.5" />
            <span>会话 ({(bot.homeThreadId ? 1 : 0) + allBotWorkerIds.size})</span>
          </button>
        </div>

        <Button size="micro" variant="outline" onClick={() => onDispatchWorker(bot, task)}>
          <PlayIcon />
          派发
        </Button>
      </div>

      {/* Main Scroll Area */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        {tab === "task" ? (
          <div className="space-y-4">
            {/* Breadcrumb Row */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                {showBackButton && onBackToAllTasks ? (
                  <button
                    type="button"
                    className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    onClick={onBackToAllTasks}
                  >
                    <ArrowLeftIcon className="size-3.5" />
                    <span>全部</span>
                  </button>
                ) : null}
                <LunaBotAvatar avatar={bot.avatar} accent={bot.accent} size="sm" />
                <span className="truncate text-xs font-medium text-foreground">{bot.name}</span>
                <span className="truncate font-mono text-2xs text-muted-foreground">
                  @{bot.handle}
                </span>
              </div>

              {onSelectTask && allTasksForBot.length > 1 ? (
                <select
                  aria-label="切换任务"
                  className="h-6 max-w-[140px] rounded border border-border bg-background px-1.5 text-2xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  value={task?.id ?? ""}
                  onChange={(event) => {
                    const nextId = event.target.value;
                    if (nextId) onSelectTask(nextId as BotTaskId);
                  }}
                >
                  {allTasksForBot.map((item) => (
                    <option key={item.id} value={item.id}>
                      #{item.number} {item.title}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>

            {task === null ? (
              <div className="rounded-xl border border-dashed border-border bg-background/60 p-4 text-center">
                <p className="text-xs font-medium text-foreground">该 Bot 暂无任务卡</p>
                <p className="mt-1 text-2xs text-muted-foreground">{bot.role}</p>
                <div className="mt-3 flex flex-wrap justify-center gap-2">
                  <Button size="compact" variant="outline" onClick={() => onEnsureHomeThread(bot)}>
                    打开主对话
                  </Button>
                  {onOpenNewTask ? (
                    <Button size="compact" onClick={() => onOpenNewTask(bot)}>
                      <PlusIcon />
                      新建任务卡
                    </Button>
                  ) : (
                    <Button size="compact" onClick={() => onDispatchWorker(bot, null)}>
                      <PlayIcon />
                      派发首个 Worker
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <>
                {/* Title + Status Row */}
                <div className="space-y-2">
                  <h2 className="text-sm leading-snug font-semibold text-foreground">
                    <span className="mr-1.5 font-mono text-muted-foreground">#{task.number}</span>
                    {task.title}
                  </h2>

                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <select
                      aria-label="任务状态"
                      disabled={!canOperate}
                      className="h-6.5 rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      value={task.status}
                      onChange={(event) =>
                        void handleStatusChange(event.target.value as BotTaskStatus)
                      }
                    >
                      {(Object.keys(BOT_TASK_STATUS_META) as ReadonlyArray<BotTaskStatus>).map(
                        (key) => (
                          <option key={key} value={key}>
                            {BOT_TASK_STATUS_META[key].label}
                          </option>
                        ),
                      )}
                    </select>
                    <Badge size="sm" variant={BOT_TASK_STATUS_META[task.status].badgeVariant}>
                      {BOT_TASK_STATUS_META[task.status].label}
                    </Badge>
                    <span className="text-2xs text-muted-foreground">
                      更新于 {formatBotElapsedLabel(task.updatedAt, nowMs)}
                    </span>
                  </div>

                  {/* Worker + PR Pills */}
                  {task.workerThreadIds.length > 0 || task.linkedPrUrls.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {task.workerThreadIds.map((workerId) => {
                        const workerThread = threadsById.get(workerId);
                        const working = isBotThreadWorking(workerThread);
                        return (
                          <button
                            key={workerId}
                            type="button"
                            className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-2 py-0.5 text-2xs text-foreground transition-colors hover:border-primary/50 hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                            onClick={() => onOpenThread(workerId)}
                          >
                            <span
                              aria-hidden
                              className={cn(
                                "size-1.5 shrink-0 rounded-full",
                                working ? botAccent.dot : "bg-success",
                              )}
                            />
                            <span className="truncate">{workerThread?.title ?? workerId}</span>
                          </button>
                        );
                      })}
                      {task.linkedPrUrls.map((url) => {
                        const safeHref = safeExternalUrl(url);
                        const label = extractPrShortLabel(url);
                        return safeHref ? (
                          <a
                            key={url}
                            href={safeHref}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 rounded-md border border-success/30 bg-success/10 px-2 py-0.5 text-2xs font-medium text-success-foreground hover:bg-success/15"
                          >
                            <PullRequestGlyph.pullRequest className="size-3" />
                            <span>{label}</span>
                          </a>
                        ) : (
                          <Badge key={url} size="sm" variant="success">
                            <PullRequestGlyph.pullRequest className="size-3" />
                            {label}
                          </Badge>
                        );
                      })}
                    </div>
                  ) : null}
                </div>

                {/* Chat / Workspace / Done Means Key-Value Block */}
                <div className="space-y-2.5 rounded-xl border border-border bg-background/60 p-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">主对话</span>
                    <button
                      type="button"
                      className="inline-flex cursor-pointer items-center gap-1 font-medium text-foreground hover:text-primary focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      onClick={() => {
                        if (bot.homeThreadId) {
                          onOpenThread(bot.homeThreadId);
                        } else {
                          onEnsureHomeThread(bot);
                        }
                      }}
                    >
                      <span>{bot.homeThreadId ? "Home Chat" : "初始化主对话"}</span>
                      <ExternalLinkIcon className="size-3 opacity-70" />
                    </button>
                  </div>

                  {project ? (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">所属项目</span>
                      <span className="truncate font-medium text-foreground">{project.title}</span>
                    </div>
                  ) : null}

                  <div className="space-y-1 border-t border-border/70 pt-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">完成标准 (Done means)</span>
                      {canOperate && editingDoneMeansForTaskId !== task.id ? (
                        <button
                          type="button"
                          className="inline-flex cursor-pointer items-center gap-1 text-2xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                          onClick={() => setEditingDoneMeansForTaskId(task.id)}
                        >
                          <PencilIcon className="size-3" />
                          <span>编辑</span>
                        </button>
                      ) : null}
                    </div>
                    {editingDoneMeansForTaskId === task.id ? (
                      <DoneMeansEditor
                        key={task.id}
                        environmentId={environmentId}
                        task={task}
                        canOperate={canOperate}
                        onDone={() => setEditingDoneMeansForTaskId(null)}
                      />
                    ) : (
                      <p className="text-xs leading-relaxed text-foreground/90">
                        {task.doneMeans && task.doneMeans.trim().length > 0
                          ? task.doneMeans
                          : "尚未设定完成标准。"}
                      </p>
                    )}
                  </div>
                </div>

                {/* Activity Timeline */}
                <div className="space-y-2">
                  <h3 className="text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
                    动态记录
                  </h3>
                  {task.activity.length === 0 ? (
                    <p className="text-xs text-muted-foreground">暂无动态。</p>
                  ) : (
                    <ul className="space-y-2">
                      {task.activity.map((entry) => (
                        <li
                          key={entry.id}
                          className="flex items-start justify-between gap-2 text-xs leading-relaxed"
                        >
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <p className="text-foreground/90">
                              <span className="font-medium text-foreground">
                                {entry.actorLabel}
                              </span>{" "}
                              <span className="text-muted-foreground">· {entry.text}</span>
                            </p>
                            {entry.threadId ? (
                              <button
                                type="button"
                                className="inline-flex cursor-pointer items-center gap-1 text-2xs text-primary hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                                onClick={() => onOpenThread(entry.threadId!)}
                              >
                                打开关联线程 →
                              </button>
                            ) : null}
                          </div>
                          <span className="shrink-0 font-mono text-3xs text-muted-foreground">
                            {formatBotElapsedLabel(entry.at, nowMs)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* Inline Needs-You Approval / Decision Card */}
                {task.pendingQuestion ? (
                  <div className="space-y-2.5 rounded-xl border border-warning/40 bg-warning/10 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        <LunaBotAvatar avatar={bot.avatar} accent={bot.accent} size="sm" />
                        <span className="text-xs font-semibold text-foreground">{bot.name}</span>
                        <Badge size="sm" variant="warning">
                          待你拍板
                        </Badge>
                      </div>
                      <span className="font-mono text-3xs text-muted-foreground">
                        {formatBotElapsedLabel(task.pendingQuestion.askedAt, nowMs)}
                      </span>
                    </div>

                    <p className="text-xs leading-relaxed text-foreground">
                      {task.pendingQuestion.prompt}
                    </p>

                    <div className="flex flex-wrap gap-1.5">
                      {task.pendingQuestion.choices.map((choice) => (
                        <Button
                          key={choice}
                          size="compact"
                          variant="outline"
                          disabled={!canAnswer || answering}
                          onClick={() => void handleAnswerChoice(choice)}
                        >
                          <CheckCircle2Icon />
                          {choice}
                        </Button>
                      ))}
                    </div>

                    <div className="flex gap-1.5 pt-0.5">
                      <input
                        type="text"
                        className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        placeholder="补充说明或直接输入自定义决定..."
                        value={answerReason}
                        onChange={(event) => setAnswerReason(event.target.value)}
                      />
                      {answerReason.trim().length > 0 ? (
                        <Button
                          size="compact"
                          disabled={!canAnswer || answering}
                          onClick={() => void handleAnswerChoice(answerReason.trim())}
                        >
                          回复 Bot
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {actionError ? (
                  <div className="flex items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
                    <AlertCircleIcon className="size-3.5 shrink-0" />
                    <span>{actionError}</span>
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : tab === "connectors" ? (
          <div className="space-y-3 text-xs">
            <div className="rounded-xl border border-border bg-background/60 p-3 space-y-2">
              <p className="font-semibold text-foreground">关联可视化工作流 (.flow.json)</p>
              {bot.linkedWorkflowNames.length === 0 ? (
                <p className="text-muted-foreground">尚未绑定可视化工作流。</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {bot.linkedWorkflowNames.map((name) => (
                    <Badge key={name} variant="info">
                      <WorkflowIcon />
                      {name}
                    </Badge>
                  ))}
                </div>
              )}
              <Button
                size="compact"
                variant="outline"
                onClick={() => void navigate({ to: "/workflows", search: { env: environmentId } })}
              >
                前往自动化面板
              </Button>
            </div>

            <div className="rounded-xl border border-border bg-background/60 p-3 space-y-1.5">
              <p className="font-semibold text-foreground">Bot 协同 MCP 工具面</p>
              <p className="text-muted-foreground leading-relaxed">
                该 Bot 的主对话与 Worker 会自动获得以下内置工具，用于更新任务卡状态与向伙伴 Bot 发起{" "}
                <span className="font-mono text-foreground">@</span> 协作接力:
              </p>
              <div className="flex flex-wrap gap-1 pt-1 font-mono text-2xs">
                <Badge size="sm" variant="outline">
                  t3_bots_list
                </Badge>
                <Badge size="sm" variant="outline">
                  t3_bot_task_upsert
                </Badge>
                <Badge size="sm" variant="outline">
                  t3_bot_dispatch
                </Badge>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-2.5 text-xs">
            <div className="rounded-xl border border-border bg-background/60 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-foreground">Home Chat (主对话)</span>
                <Badge size="sm" variant={bot.homeThreadId ? "success" : "outline"}>
                  {bot.homeThreadId ? "已创建" : "懒创建 (零开销)"}
                </Badge>
              </div>
              <Button
                size="compact"
                variant="outline"
                className="w-full justify-between"
                onClick={() => {
                  if (bot.homeThreadId) {
                    onOpenThread(bot.homeThreadId);
                  } else {
                    onEnsureHomeThread(bot);
                  }
                }}
              >
                <span>{bot.homeThreadId ? "进入 Home Chat 对话" : "初始化并进入 Home Chat"}</span>
                <ExternalLinkIcon />
              </Button>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-2xs font-semibold text-muted-foreground uppercase">
                  Worker 子线程 ({allBotWorkerIds.size})
                </span>
                <Button size="micro" variant="ghost" onClick={() => onDispatchWorker(bot, task)}>
                  <PlusIcon />
                  新建 Worker
                </Button>
              </div>
              {allBotWorkerIds.size === 0 ? (
                <p className="text-muted-foreground">暂无关联 Worker 子线程。</p>
              ) : (
                <div className="space-y-1">
                  {[...allBotWorkerIds].map((workerId) => {
                    const thread = threadsById.get(workerId);
                    const working = isBotThreadWorking(thread);
                    return (
                      <button
                        key={workerId}
                        type="button"
                        className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg border border-border bg-background/70 px-2.5 py-2 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        onClick={() => onOpenThread(workerId)}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            aria-hidden
                            className={cn(
                              "size-2 shrink-0 rounded-full",
                              working ? botAccent.dot : "bg-success",
                            )}
                          />
                          <span className="truncate font-medium text-foreground">
                            {thread?.title ?? workerId}
                          </span>
                        </div>
                        <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                          {thread ? formatBotElapsedLabel(thread.updatedAt, nowMs) : "离线"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom Comment Composer */}
      {tab === "task" && task ? (
        <form
          onSubmit={(event) => void handleCommentSubmit(event)}
          className="shrink-0 border-t border-border bg-background/70 p-2.5 space-y-1.5"
        >
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              disabled={!canComment || commenting}
              className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-2.5 text-xs text-foreground outline-none placeholder:text-placeholder focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25"
              placeholder="+ 添加评论或追问..."
              value={commentText}
              onChange={(event) => setCommentText(event.target.value)}
            />
            <Button
              type="submit"
              size="icon-sm"
              disabled={!canComment || commenting || commentText.trim().length === 0}
              aria-label="发送评论"
            >
              <SendIcon />
            </Button>
          </div>
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-2xs text-muted-foreground">
            <input
              type="checkbox"
              className="rounded border-input accent-primary"
              checked={notifyBot}
              onChange={(event) => setNotifyBot(event.target.checked)}
            />
            <MessageSquarePlusIcon className="size-3" />
            <span>评论同步推送到 {bot.name} 主对话</span>
          </label>
        </form>
      ) : null}
    </div>
  );
}
