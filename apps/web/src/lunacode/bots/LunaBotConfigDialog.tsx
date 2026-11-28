import { sanitizeBotHandle } from "@t3tools/client-runtime/lunacode/bots";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type BotAccent,
  type BotAvatarPreset,
  BotHandle,
  type BotWorkspaceStrategy,
  type EnvironmentId,
  type PersistentBot,
  ProjectId,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { BotIcon, SaveIcon } from "lucide-react";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  BOT_ACCENT_OPTIONS,
  BOT_ACCENT_STYLES,
  BOT_AVATAR_PRESETS,
  LunaBotAvatar,
  extractBotErrorMessage,
} from "./LunaBotAvatar";
import { cn } from "~/lib/utils";

const INPUT_CLASS =
  "h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25";
const SELECT_CLASS =
  "h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25";
const TEXTAREA_CLASS =
  "w-full rounded-md border border-input bg-background p-2.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25";

const normalizeWorkflowName = (tag: string): string => tag.replace(/@\d+$/, "");

function BotConfigForm({
  environmentId,
  initialBot,
  onOpenChange,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly initialBot: PersistentBot | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved?: ((bot: PersistentBot) => void) | undefined;
}) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? [];
  const definitionsQuery = useEnvironmentQuery(
    serverEnvironment.workflowDefinition({ environmentId, input: {} }),
  );
  const canUpsert = useAtomValue(serverEnvironment.upsertBot.permissionAtom(environmentId));
  const upsertBot = useAtomCommand(serverEnvironment.upsertBot, {
    label: "upsert persistent bot",
    reportFailure: false,
  });

  const [name, setName] = useState(initialBot?.name ?? "");
  const [handle, setHandle] = useState(initialBot?.handle ?? "");
  const [handleEdited, setHandleEdited] = useState(initialBot !== null);
  const [role, setRole] = useState(initialBot?.role ?? "工程协作专员");
  const [avatar, setAvatar] = useState<BotAvatarPreset>(initialBot?.avatar ?? "scout");
  const [accent, setAccent] = useState<BotAccent>(initialBot?.accent ?? "info");
  const [systemPrompt, setSystemPrompt] = useState(initialBot?.systemPrompt ?? "");
  const [defaultProjectId, setDefaultProjectId] = useState<string>(
    initialBot?.defaultProjectId ?? projects[0]?.id ?? "",
  );
  const [providerInstanceId, setProviderInstanceId] = useState<string>(
    initialBot?.providerInstanceId ?? "",
  );
  const [model, setModel] = useState<string>(initialBot?.model ?? "");
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(
    initialBot?.runtimeMode ?? "full-access",
  );
  const [interactionMode, setInteractionMode] = useState<ProviderInteractionMode>(
    initialBot?.interactionMode ?? "default",
  );
  const [workspaceStrategy, setWorkspaceStrategy] = useState<BotWorkspaceStrategy>(
    initialBot?.workspaceStrategy ?? "worktree",
  );
  const [linkedWorkflows, setLinkedWorkflows] = useState<ReadonlyArray<string>>(() =>
    Array.from(new Set((initialBot?.linkedWorkflowNames ?? []).map(normalizeWorkflowName))),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedProvider = providers.find((provider) => provider.instanceId === providerInstanceId);
  const availableWorkflowNames = Array.from(
    new Set([
      ...linkedWorkflows,
      ...(definitionsQuery.data?.files.flatMap((file) => file.workflows) ?? []).map(
        normalizeWorkflowName,
      ),
    ]),
  );

  const toggleWorkflow = (wfName: string) => {
    setLinkedWorkflows((current) =>
      current.includes(wfName) ? current.filter((item) => item !== wfName) : [...current, wfName],
    );
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !canUpsert) return;
    const cleanName = name.trim();
    if (!cleanName) {
      setError("请输入 Bot 名称。");
      return;
    }
    const normalizedHandle = sanitizeBotHandle(handle || cleanName);
    const cleanRole = role.trim() || "工程协作专员";

    setSaving(true);
    setError(null);
    const result = await upsertBot({
      environmentId,
      input: {
        ...(initialBot ? { id: initialBot.id } : {}),
        name: TrimmedNonEmptyString.make(cleanName),
        handle: BotHandle.make(normalizedHandle),
        role: TrimmedNonEmptyString.make(cleanRole),
        avatar,
        accent,
        systemPrompt,
        defaultProjectId: defaultProjectId ? ProjectId.make(defaultProjectId) : null,
        providerInstanceId: providerInstanceId ? (providerInstanceId as ProviderInstanceId) : null,
        model: model.trim() ? TrimmedNonEmptyString.make(model.trim()) : null,
        runtimeMode,
        interactionMode,
        workspaceStrategy,
        linkedWorkflowNames: [...linkedWorkflows],
      },
    });
    setSaving(false);

    if (result._tag === "Success") {
      onOpenChange(false);
      onSaved?.(result.value);
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
          <LunaBotAvatar avatar={avatar} accent={accent} size="md" />
          <div>
            <DialogTitle>{initialBot ? `编辑 ${initialBot.name}` : "新建常驻协作 Bot"}</DialogTitle>
            <DialogDescription>
              配置持久身份、默认项目、模型偏好及 Worktree 策略，按需打开主对话。
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <DialogPanel>
        <div className="space-y-3.5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Bot 名称</span>
              <input
                type="text"
                className={INPUT_CLASS}
                placeholder="例如: 苏探 · Scout 或 林清 · Review"
                value={name}
                onChange={(event) => {
                  const nextName = event.target.value;
                  setName(nextName);
                  if (!handleEdited) {
                    setHandle(sanitizeBotHandle(nextName));
                  }
                }}
              />
            </label>

            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">@Handle 标识</span>
              <input
                type="text"
                className={`${INPUT_CLASS} font-mono`}
                placeholder="scout"
                value={handle}
                onChange={(event) => {
                  setHandleEdited(true);
                  setHandle(event.target.value);
                }}
              />
            </label>
          </div>

          <div className="space-y-3">
            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">职责定位</span>
              <input
                type="text"
                className={INPUT_CLASS}
                placeholder="例如: Bug 猎手 & 并行主控"
                value={role}
                onChange={(event) => setRole(event.target.value)}
              />
            </label>

            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-muted-foreground">真人风格头像</span>
              <div className="grid grid-cols-4 gap-2">
                {BOT_AVATAR_PRESETS.map((preset) => {
                  const selected = avatar === preset.value;
                  return (
                    <Tooltip key={preset.value}>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-pressed={selected}
                            className={cn(
                              "flex cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                              selected
                                ? "border-primary bg-primary/10 text-foreground"
                                : "border-border bg-card/70 text-muted-foreground hover:border-primary/40 hover:text-foreground",
                            )}
                            onClick={() => setAvatar(preset.value)}
                          >
                            <LunaBotAvatar avatar={preset.value} accent={accent} size="sm" />
                            <span className="min-w-0">
                              <span className="block truncate text-xs font-medium text-foreground">
                                {preset.personaName}
                              </span>
                              <span className="block truncate text-3xs text-muted-foreground">
                                {preset.styleLabel}
                              </span>
                            </span>
                          </button>
                        }
                      />
                      <TooltipPopup>
                        {preset.label} · {preset.summary}
                      </TooltipPopup>
                    </Tooltip>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-muted-foreground">状态徽章色调</span>
              <div className="flex flex-wrap gap-1.5">
                {BOT_ACCENT_OPTIONS.map((opt) => {
                  const selected = accent === opt.value;
                  const style = BOT_ACCENT_STYLES[opt.value];
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      aria-pressed={selected}
                      className={cn(
                        "inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        selected
                          ? "border-primary bg-primary/10 font-medium text-foreground"
                          : "border-border bg-background text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => setAccent(opt.value)}
                    >
                      <span aria-hidden className={cn("size-2.5 rounded-full", style.dot)} />
                      <span>{opt.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">默认项目</span>
              <select
                className={SELECT_CLASS}
                value={defaultProjectId}
                onChange={(event) => setDefaultProjectId(event.target.value)}
              >
                <option value="">跟随当前工作区</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.title}
                  </option>
                ))}
              </select>
            </label>

            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Worker 策略</span>
              <select
                className={SELECT_CLASS}
                value={workspaceStrategy}
                onChange={(event) =>
                  setWorkspaceStrategy(event.target.value as BotWorkspaceStrategy)
                }
              >
                <option value="worktree">隔离 Worktree (默认推荐)</option>
                <option value="root">项目根目录</option>
              </select>
            </label>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">模型引擎</span>
              <select
                className={SELECT_CLASS}
                value={providerInstanceId}
                onChange={(event) => {
                  const nextId = event.target.value;
                  setProviderInstanceId(nextId);
                  setModel("");
                }}
              >
                <option value="">使用系统默认 Provider</option>
                {providers
                  .filter((provider) => provider.enabled)
                  .map((provider) => (
                    <option key={provider.instanceId} value={provider.instanceId}>
                      {provider.displayName}
                    </option>
                  ))}
              </select>
            </label>

            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">指定模型</span>
              {selectedProvider && selectedProvider.models.length > 0 ? (
                <select
                  className={SELECT_CLASS}
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                >
                  <option value="">默认推荐模型</option>
                  {selectedProvider.models.map((item) => (
                    <option key={item.slug} value={item.slug}>
                      {item.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  className={INPUT_CLASS}
                  placeholder="留空则跟随默认模型"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                />
              )}
            </label>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">执行权限</span>
              <select
                className={SELECT_CLASS}
                value={runtimeMode}
                onChange={(event) => setRuntimeMode(event.target.value as RuntimeMode)}
              >
                <option value="full-access">Full Access (自动执行)</option>
                <option value="auto-accept-edits">仅自动应用编辑</option>
                <option value="approval-required">关键操作需确认</option>
                <option value="auto">智能自适应</option>
              </select>
            </label>

            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">交互风格</span>
              <select
                className={SELECT_CLASS}
                value={interactionMode}
                onChange={(event) =>
                  setInteractionMode(event.target.value as ProviderInteractionMode)
                }
              >
                <option value="default">直接协作 (Default)</option>
                <option value="plan">先出方案 (Plan)</option>
              </select>
            </label>
          </div>

          <label className="block space-y-1">
            <span className="block text-xs font-medium text-muted-foreground">
              系统职责与协同规范 (System Prompt)
            </span>
            <textarea
              rows={3}
              className={TEXTAREA_CLASS}
              placeholder="定义该 Bot 的排查范围、汇报格式，以及何时将任务交接给 @其他Bot..."
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
            />
          </label>

          {availableWorkflowNames.length > 0 ? (
            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-muted-foreground">
                关联自动化工作流 (.flow.json)
              </span>
              <div className="flex flex-wrap gap-1.5">
                {availableWorkflowNames.map((wfName) => {
                  const selected = linkedWorkflows.includes(wfName);
                  return (
                    <button
                      key={wfName}
                      type="button"
                      aria-pressed={selected}
                      className={`cursor-pointer rounded-md border px-2 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                        selected
                          ? "border-primary/50 bg-primary/15 text-foreground font-medium"
                          : "border-border bg-background text-muted-foreground hover:text-foreground"
                      }`}
                      onClick={() => toggleWorkflow(wfName)}
                    >
                      {wfName}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      </DialogPanel>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          取消
        </Button>
        <Button type="submit" data-slot="dialog-action" disabled={!canUpsert || saving}>
          {initialBot ? <SaveIcon /> : <BotIcon />}
          {saving ? "保存中..." : initialBot ? "保存配置" : "创建 Bot"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function LunaBotConfigDialog({
  open,
  environmentId,
  initialBot,
  onOpenChange,
  onSaved,
}: {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly initialBot: PersistentBot | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved?: ((bot: PersistentBot) => void) | undefined;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        {open ? (
          <BotConfigForm
            key={initialBot?.id ?? "new-bot"}
            environmentId={environmentId}
            initialBot={initialBot}
            onOpenChange={onOpenChange}
            {...(onSaved ? { onSaved } : {})}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
