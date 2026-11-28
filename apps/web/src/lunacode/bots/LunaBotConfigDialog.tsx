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
import { useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  BOT_ACCENT_OPTIONS,
  BOT_AVATAR_PRESETS,
  LunaBotAvatar,
  extractBotErrorMessage,
} from "./LunaBotAvatar";

const INPUT_CLASS =
  "h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25";
const SELECT_CLASS =
  "h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25";
const TEXTAREA_CLASS =
  "w-full rounded-md border border-input bg-background p-2.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25";

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
  const [linkedWorkflows, setLinkedWorkflows] = useState<ReadonlyArray<string>>(
    initialBot?.linkedWorkflowNames ?? [],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedProvider = providers.find((provider) => provider.instanceId === providerInstanceId);
  const availableWorkflowNames =
    definitionsQuery.data?.files.flatMap((file) => file.workflows) ?? [];

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
    <form onSubmit={(event) => void handleSubmit(event)}>
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
                placeholder="例如: Scout 或 Review buddy"
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

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="block space-y-1 sm:col-span-1">
              <span className="block text-xs font-medium text-muted-foreground">职责定位</span>
              <input
                type="text"
                className={INPUT_CLASS}
                placeholder="例如: 代码审查"
                value={role}
                onChange={(event) => setRole(event.target.value)}
              />
            </label>

            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">图标</span>
              <select
                className={SELECT_CLASS}
                value={avatar}
                onChange={(event) => setAvatar(event.target.value as BotAvatarPreset)}
              >
                {BOT_AVATAR_PRESETS.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">主题色调</span>
              <select
                className={SELECT_CLASS}
                value={accent}
                onChange={(event) => setAccent(event.target.value as BotAccent)}
              >
                {BOT_ACCENT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
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
