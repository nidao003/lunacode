import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type BotId,
  type BotTask,
  type BotTaskId,
  type BotWorkspaceStrategy,
  type EnvironmentId,
  type PersistentBot,
  ProjectId,
  type ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { PlayIcon, SendIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { useProjects } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { LunaBotAvatar, extractBotErrorMessage } from "./LunaBotAvatar";

const INPUT_CLASS =
  "h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25";
const SELECT_CLASS =
  "h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25";
const TEXTAREA_CLASS =
  "w-full rounded-md border border-input bg-background p-2.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25";

function DispatchForm({
  environmentId,
  bots,
  tasks,
  defaultBotId,
  defaultTaskId,
  defaultMode,
  defaultPrompt,
  defaultProjectId,
  onOpenChange,
  onDispatched,
}: {
  readonly environmentId: EnvironmentId;
  readonly bots: ReadonlyArray<PersistentBot>;
  readonly tasks: ReadonlyArray<BotTask>;
  readonly defaultBotId: BotId | null;
  readonly defaultTaskId: BotTaskId | null;
  readonly defaultMode: "worker" | "message";
  readonly defaultPrompt: string;
  readonly defaultProjectId: ProjectId | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDispatched?: ((threadId: ThreadId, environmentId: EnvironmentId) => void) | undefined;
}) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const canDispatch = useAtomValue(
    serverEnvironment.dispatchBotWorker.permissionAtom(environmentId),
  );
  const canSend = useAtomValue(serverEnvironment.sendBotMessage.permissionAtom(environmentId));
  const dispatchWorker = useAtomCommand(serverEnvironment.dispatchBotWorker, {
    label: "bot dispatch worker",
    reportFailure: false,
  });
  const sendBotMessage = useAtomCommand(serverEnvironment.sendBotMessage, {
    label: "bot send message",
    reportFailure: false,
  });

  const initialBot =
    bots.find((bot) => bot.id === defaultBotId && bot.archived !== true) ??
    bots.find((bot) => bot.archived !== true) ??
    null;

  const [mode, setMode] = useState<"worker" | "message">(defaultMode);
  const [selectedBotId, setSelectedBotId] = useState<string>(initialBot?.id ?? "");
  const [selectedTaskId, setSelectedTaskId] = useState<string>(defaultTaskId ?? "");
  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    defaultProjectId ?? initialBot?.defaultProjectId ?? projects[0]?.id ?? "",
  );
  const [workspaceStrategy, setWorkspaceStrategy] = useState<BotWorkspaceStrategy>(
    initialBot?.workspaceStrategy ?? "worktree",
  );
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeBot = bots.find((bot) => bot.id === selectedBotId) ?? initialBot;
  const botTasks = activeBot
    ? tasks.filter((task) => task.botId === activeBot.id && task.status !== "cancelled")
    : [];
  const permitted = mode === "worker" ? canDispatch : canSend;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!activeBot || submitting) return;
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) {
      setError("请输入具体的执行指令或交接内容。");
      return;
    }

    setSubmitting(true);
    setError(null);

    if (mode === "message") {
      const result = await sendBotMessage({
        environmentId,
        input: {
          botId: activeBot.id,
          message: TrimmedNonEmptyString.make(cleanPrompt),
          ...(selectedTaskId ? { taskId: selectedTaskId as BotTaskId } : {}),
          ...(selectedProjectId ? { projectId: ProjectId.make(selectedProjectId) } : {}),
        },
      });
      setSubmitting(false);
      if (result._tag === "Success") {
        onOpenChange(false);
        onDispatched?.(result.value.threadId, environmentId);
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        setError(extractBotErrorMessage(squashAtomCommandFailure(result)));
      }
      return;
    }

    const cleanTitle = title.trim() || cleanPrompt.slice(0, 48);
    const result = await dispatchWorker({
      environmentId,
      input: {
        botId: activeBot.id,
        title: TrimmedNonEmptyString.make(cleanTitle),
        prompt: TrimmedNonEmptyString.make(cleanPrompt),
        workspaceStrategy,
        ...(selectedTaskId ? { taskId: selectedTaskId as BotTaskId } : {}),
        ...(selectedProjectId ? { projectId: ProjectId.make(selectedProjectId) } : {}),
      },
    });
    setSubmitting(false);
    if (result._tag === "Success") {
      onOpenChange(false);
      onDispatched?.(result.value.threadId, environmentId);
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setError(extractBotErrorMessage(squashAtomCommandFailure(result)));
    }
  };

  return (
    <form
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      onSubmit={(event) => void handleSubmit(event)}
    >
      <DialogHeader>
        <div className="flex items-center gap-2.5">
          {activeBot ? (
            <LunaBotAvatar avatar={activeBot.avatar} accent={activeBot.accent} size="md" />
          ) : null}
          <div>
            <DialogTitle>
              {mode === "worker" ? "派发 Worker 执行线程" : "向 Bot 主对话发消息"}
            </DialogTitle>
            <DialogDescription>
              {activeBot
                ? `${activeBot.name} (@${activeBot.handle}) · ${activeBot.role}`
                : "Worker 会在独立 Worktree 或工作区根目录开启子线程并自动关联到 #N 任务卡。"}
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <DialogPanel>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-muted/40 p-1">
            <button
              type="button"
              className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                mode === "worker"
                  ? "bg-card text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setMode("worker")}
            >
              独立 Worker 线程
            </button>
            <button
              type="button"
              className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                mode === "message"
                  ? "bg-card text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setMode("message")}
            >
              发送至 Home Chat
            </button>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">目标 Bot</span>
              <select
                className={SELECT_CLASS}
                value={activeBot?.id ?? ""}
                onChange={(event) => {
                  const nextId = event.target.value;
                  setSelectedBotId(nextId);
                  setSelectedTaskId("");
                  const nextBot = bots.find((b) => b.id === nextId);
                  if (nextBot) {
                    setWorkspaceStrategy(nextBot.workspaceStrategy);
                    if (nextBot.defaultProjectId) {
                      setSelectedProjectId(nextBot.defaultProjectId);
                    }
                  }
                }}
              >
                {bots
                  .filter((bot) => bot.archived !== true)
                  .map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {bot.name} (@{bot.handle})
                    </option>
                  ))}
              </select>
            </label>

            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">
                关联任务 (可选)
              </span>
              <select
                className={SELECT_CLASS}
                value={selectedTaskId}
                onChange={(event) => setSelectedTaskId(event.target.value)}
              >
                <option value="">
                  {mode === "worker" ? "自动创建新 #N 任务卡" : "不绑定特定任务"}
                </option>
                {botTasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    #{task.number} {task.title}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">目标项目</span>
              <select
                className={SELECT_CLASS}
                value={selectedProjectId}
                onChange={(event) => setSelectedProjectId(event.target.value)}
              >
                {projects.length === 0 ? <option value="">当前工作区无项目</option> : null}
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.title}
                  </option>
                ))}
              </select>
            </label>

            {mode === "worker" ? (
              <label className="block space-y-1">
                <span className="block text-xs font-medium text-muted-foreground">工作区策略</span>
                <select
                  className={SELECT_CLASS}
                  value={workspaceStrategy}
                  onChange={(event) =>
                    setWorkspaceStrategy(event.target.value as BotWorkspaceStrategy)
                  }
                >
                  <option value="worktree">隔离 Worktree (推荐并行)</option>
                  <option value="root">项目根目录 (只读排查)</option>
                </select>
              </label>
            ) : null}
          </div>

          {mode === "worker" ? (
            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">
                Worker 任务标题
              </span>
              <input
                type="text"
                className={INPUT_CLASS}
                placeholder="例如: safari-pay-click 或 排查 E2E 抖动"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
          ) : null}

          <label className="block space-y-1">
            <span className="block text-xs font-medium text-muted-foreground">
              {mode === "worker" ? "执行指令 (Prompt)" : "主对话消息 / 交接指令"}
            </span>
            <textarea
              rows={4}
              className={TEXTAREA_CLASS}
              placeholder={
                mode === "worker"
                  ? "描述要排查的问题、预期结果或测试验证要求..."
                  : "向该 Bot 同步上下文或下发协作指令 (支持 @其他Bot)..."
              }
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      </DialogPanel>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          取消
        </Button>
        <Button
          type="submit"
          data-slot="dialog-action"
          disabled={!permitted || !activeBot || submitting}
        >
          {mode === "worker" ? <PlayIcon /> : <SendIcon />}
          {submitting ? "派发中..." : mode === "worker" ? "启动 Worker" : "发送到主对话"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function LunaBotDispatchDialog({
  open,
  environmentId,
  bots,
  tasks,
  defaultBotId = null,
  defaultTaskId = null,
  defaultMode = "worker",
  defaultPrompt = "",
  defaultProjectId = null,
  onOpenChange,
  onDispatched,
}: {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly bots: ReadonlyArray<PersistentBot>;
  readonly tasks: ReadonlyArray<BotTask>;
  readonly defaultBotId?: BotId | null;
  readonly defaultTaskId?: BotTaskId | null;
  readonly defaultMode?: "worker" | "message";
  readonly defaultPrompt?: string;
  readonly defaultProjectId?: ProjectId | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDispatched?: ((threadId: ThreadId, environmentId: EnvironmentId) => void) | undefined;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        {open ? (
          <DispatchForm
            key={`${defaultBotId ?? "any"}:${defaultTaskId ?? "none"}:${defaultMode}:${defaultPrompt}`}
            environmentId={environmentId}
            bots={bots}
            tasks={tasks}
            defaultBotId={defaultBotId}
            defaultTaskId={defaultTaskId}
            defaultMode={defaultMode}
            defaultPrompt={defaultPrompt}
            defaultProjectId={defaultProjectId}
            onOpenChange={onOpenChange}
            {...(onDispatched ? { onDispatched } : {})}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
