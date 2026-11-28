import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  FlowBotRole,
  FlowSpec,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import { BotIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { serverEnvironment } from "../../state/server";

const INPUT_CLASS =
  "h-7.5 w-full rounded-md border border-input bg-background px-2.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25";
const SELECT_CLASS =
  "h-7.5 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25";
const TEXTAREA_CLASS =
  "w-full rounded-md border border-input bg-background p-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25";

export function LunaFlowRolesPanel({
  environmentId,
  spec,
  onChangeSpec,
}: {
  readonly environmentId: EnvironmentId;
  readonly spec: FlowSpec;
  readonly onChangeSpec: (next: FlowSpec) => void;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? [];
  const botEntries = Object.entries(spec.bots);

  const patchBot = (botId: string, updater: (role: FlowBotRole) => FlowBotRole) => {
    const existing = spec.bots[botId];
    if (!existing) return;
    onChangeSpec({
      ...spec,
      bots: {
        ...spec.bots,
        [botId]: updater(existing),
      },
    });
  };

  const addBot = () => {
    let idx = botEntries.length + 1;
    let candidate = `bot_${idx}`;
    while (Object.hasOwn(spec.bots, candidate)) {
      idx += 1;
      candidate = `bot_${idx}`;
    }
    const defaultProvider = providers.find((p) => p.enabled && p.models.length > 0);
    const defaultModel =
      defaultProvider?.models.find((m) => m.isDefault) ?? defaultProvider?.models[0];
    onChangeSpec({
      ...spec,
      bots: {
        ...spec.bots,
        [candidate]: {
          label: `协作 Bot ${idx}`,
          runtimeMode: "approval-required",
          workspace: "worktree",
          workspaceBaseRef: "HEAD",
          ...(defaultProvider && defaultModel
            ? { providerInstanceId: defaultProvider.instanceId, model: defaultModel.slug }
            : {}),
        },
      },
    });
  };

  const removeBot = (botId: string) => {
    const nextBots = { ...spec.bots };
    delete nextBots[botId];
    onChangeSpec({ ...spec, bots: nextBots });
  };

  return (
    <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-auto p-4 sm:p-5">
      <div className="mx-auto w-full max-w-4xl space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Bot 角色花名册</h2>
            <p className="text-xs text-muted-foreground">
              为每个专业角色独立指定模型供应商、工作区隔离方式（Worktree/Root）、权限和系统职责描述。
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={addBot}>
            <PlusIcon />
            <span>新增 Bot 角色</span>
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {botEntries.map(([botId, role]) => {
            const referencedCount = spec.nodes.filter(
              (n) => n.kind === "agent" && n.botId === botId,
            ).length;
            const selectedProvider =
              providers.find((p) => p.instanceId === role.providerInstanceId) ?? null;

            return (
              <section
                key={botId}
                className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3.5"
              >
                <div className="flex items-center justify-between gap-2 border-b border-border pb-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <BotIcon className="size-4 shrink-0 text-info-foreground" />
                    <span className="truncate font-mono text-xs font-semibold text-foreground">
                      {botId}
                    </span>
                    <Badge size="sm" variant="outline">
                      引用 {referencedCount} 次
                    </Badge>
                  </div>
                  {referencedCount === 0 && botEntries.length > 1 ? (
                    <Button size="xs" variant="ghost-destructive" onClick={() => removeBot(botId)}>
                      <Trash2Icon />
                      <span>移除</span>
                    </Button>
                  ) : null}
                </div>

                <label className="block space-y-1">
                  <span className="block text-xs font-medium text-muted-foreground">
                    角色显示名
                  </span>
                  <input
                    type="text"
                    className={INPUT_CLASS}
                    value={role.label}
                    onChange={(event) =>
                      patchBot(botId, (cur) => ({
                        ...cur,
                        label: event.target.value || botId,
                      }))
                    }
                  />
                </label>

                <div className="grid grid-cols-2 gap-2">
                  <label className="block space-y-1">
                    <span className="block text-xs font-medium text-muted-foreground">
                      Provider
                    </span>
                    <select
                      className={SELECT_CLASS}
                      value={role.providerInstanceId ?? ""}
                      onChange={(event) => {
                        const instId = event.target.value;
                        const found = providers.find((p) => p.instanceId === instId);
                        const firstModel =
                          found?.models.find((m) => m.isDefault) ?? found?.models[0];
                        patchBot(botId, (cur) => ({
                          ...cur,
                          ...(instId
                            ? {
                                providerInstanceId: instId,
                                ...(firstModel ? { model: firstModel.slug } : {}),
                              }
                            : { providerInstanceId: undefined, model: undefined }),
                        }));
                      }}
                    >
                      <option value="">默认 Provider</option>
                      {providers.map((provider) => (
                        <option key={provider.instanceId} value={provider.instanceId}>
                          {provider.displayName ?? provider.driver} ({provider.instanceId})
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block space-y-1">
                    <span className="block text-xs font-medium text-muted-foreground">模型</span>
                    {selectedProvider && selectedProvider.models.length > 0 ? (
                      <select
                        className={SELECT_CLASS}
                        value={role.model ?? ""}
                        onChange={(event) => {
                          const slug = event.target.value;
                          patchBot(botId, (cur) => ({
                            ...cur,
                            ...(slug ? { model: slug } : { model: undefined }),
                          }));
                        }}
                      >
                        <option value="">默认模型</option>
                        {selectedProvider.models.map((m) => (
                          <option key={m.slug} value={m.slug}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        className={`${INPUT_CLASS} font-mono`}
                        placeholder="模型 slug（可选）"
                        value={role.model ?? ""}
                        onChange={(event) => {
                          const model = event.target.value.trim();
                          patchBot(botId, (cur) => ({
                            ...cur,
                            ...(model ? { model } : { model: undefined }),
                          }));
                        }}
                      />
                    )}
                  </label>
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)_minmax(0,0.9fr)]">
                  <label className="block space-y-1">
                    <span className="block text-xs font-medium text-muted-foreground">
                      权限模式
                    </span>
                    <select
                      className={SELECT_CLASS}
                      value={role.runtimeMode}
                      onChange={(event) =>
                        patchBot(botId, (cur) => ({
                          ...cur,
                          runtimeMode: event.target.value as RuntimeMode,
                        }))
                      }
                    >
                      <option value="approval-required">approval-required</option>
                      <option value="auto-accept-edits">auto-accept-edits</option>
                      <option value="auto">auto</option>
                      <option value="full-access">full-access</option>
                    </select>
                  </label>

                  <label className="block space-y-1">
                    <span className="block text-xs font-medium text-muted-foreground">
                      交互模式
                    </span>
                    <select
                      className={SELECT_CLASS}
                      value={role.interactionMode ?? "default"}
                      onChange={(event) =>
                        patchBot(botId, (cur) => ({
                          ...cur,
                          interactionMode: event.target.value as ProviderInteractionMode,
                        }))
                      }
                    >
                      <option value="default">default</option>
                      <option value="plan">plan</option>
                    </select>
                  </label>

                  <label className="block space-y-1">
                    <span className="block text-xs font-medium text-muted-foreground">工作区</span>
                    <select
                      className={SELECT_CLASS}
                      value={role.workspace ?? "root"}
                      onChange={(event) =>
                        patchBot(botId, (cur) => ({
                          ...cur,
                          workspace: event.target.value as "root" | "worktree",
                        }))
                      }
                    >
                      <option value="worktree">worktree</option>
                      <option value="root">root</option>
                    </select>
                  </label>
                </div>

                <label className="block space-y-1">
                  <span className="block text-xs font-medium text-muted-foreground">
                    角色系统职责 Prompt
                  </span>
                  <textarea
                    rows={3}
                    className={TEXTAREA_CLASS}
                    placeholder="描述该 Bot 专长的检查清单、纪律和产出规范..."
                    value={role.rolePrompt ?? ""}
                    onChange={(event) => {
                      const val = event.target.value;
                      patchBot(botId, (cur) => ({
                        ...cur,
                        ...(val ? { rolePrompt: val } : { rolePrompt: undefined }),
                      }));
                    }}
                  />
                </label>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
