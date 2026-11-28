import type { FlowSpec, FlowTrigger } from "@t3tools/contracts";
import { PlusIcon, ShieldAlertIcon, Trash2Icon, ZapIcon } from "lucide-react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";

const INPUT_CLASS =
  "h-7.5 w-full rounded-md border border-input bg-background px-2.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25";
const SELECT_CLASS =
  "h-7.5 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25";
const TEXTAREA_CLASS =
  "w-full rounded-md border border-input bg-background p-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25";

function triggerIdentity(trigger: FlowTrigger, occurrence: number): string {
  return `${trigger.kind}:${occurrence}`;
}

function createDefaultTrigger(kind: FlowTrigger["kind"]): FlowTrigger {
  switch (kind) {
    case "manual":
      return { kind: "manual" };
    case "every":
      return { kind: "every", interval: "30 minutes" };
    case "daily":
      return { kind: "daily", timeOfDay: "09:00" };
    case "webhook":
      return { kind: "webhook", name: "event-hook" };
    case "issues.opened":
      return { kind: "issues.opened", project: "default-project" };
    case "pullRequests.opened":
      return { kind: "pullRequests.opened", project: "default-project" };
  }
}

export function LunaFlowSettingsPanel({
  spec,
  onChangeSpec,
}: {
  readonly spec: FlowSpec;
  readonly onChangeSpec: (next: FlowSpec) => void;
}) {
  const patchTrigger = (index: number, next: FlowTrigger) => {
    onChangeSpec({
      ...spec,
      triggers: spec.triggers.map((t, i) => (i === index ? next : t)),
    });
  };

  return (
    <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-auto p-4 sm:p-5">
      <div className="mx-auto w-full max-w-3xl space-y-5">
        {/* Metadata & Safety Limits */}
        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between border-b border-border pb-2">
            <h2 className="text-sm font-semibold text-foreground">基本信息与熔断约束</h2>
            <Badge size="sm" variant="outline">
              schema v{spec.schemaVersion} · 版本 v{spec.version}
            </Badge>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">
                工作流唯一标识 (name)
              </span>
              <input
                type="text"
                className={`${INPUT_CLASS} font-mono`}
                value={spec.name}
                onChange={(event) => {
                  const clean = event.target.value.trim();
                  if (clean.length > 0) onChangeSpec({ ...spec, name: clean });
                }}
              />
            </label>
            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">标题 (可选)</span>
              <input
                type="text"
                className={INPUT_CLASS}
                value={spec.title ?? ""}
                onChange={(event) => {
                  const val = event.target.value;
                  onChangeSpec({ ...spec, ...(val ? { title: val } : { title: undefined }) });
                }}
              />
            </label>
          </div>

          <label className="block space-y-1">
            <span className="block text-xs font-medium text-muted-foreground">流程说明</span>
            <textarea
              rows={2}
              className={TEXTAREA_CLASS}
              value={spec.description ?? ""}
              onChange={(event) => {
                const val = event.target.value;
                onChangeSpec({
                  ...spec,
                  ...(val ? { description: val } : { description: undefined }),
                });
              }}
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">
                最大回流次数 (maxHops)
              </span>
              <input
                type="number"
                min={1}
                max={20}
                className={INPUT_CLASS}
                value={spec.maxHops ?? 2}
                onChange={(event) => {
                  const num = Number(event.target.value);
                  if (Number.isInteger(num) && num >= 1 && num <= 20) {
                    onChangeSpec({ ...spec, maxHops: num });
                  }
                }}
              />
            </label>
            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">
                最大同时运行实例数
              </span>
              <input
                type="number"
                min={1}
                placeholder="默认不限制"
                className={INPUT_CLASS}
                value={spec.concurrency ?? ""}
                onChange={(event) => {
                  const raw = event.target.value.trim();
                  if (!raw) {
                    onChangeSpec({ ...spec, concurrency: undefined });
                    return;
                  }
                  const num = Number(raw);
                  if (Number.isInteger(num) && num >= 1) {
                    onChangeSpec({ ...spec, concurrency: num });
                  }
                }}
              />
            </label>
          </div>
        </section>

        {/* Triggers */}
        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
            <div className="flex items-center gap-1.5">
              <ZapIcon className="size-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">触发器</h2>
            </div>
            <div className="flex flex-wrap gap-1">
              {(
                [
                  "manual",
                  "every",
                  "daily",
                  "webhook",
                  "issues.opened",
                  "pullRequests.opened",
                ] as const
              ).map((kind) => (
                <Button
                  key={kind}
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    onChangeSpec({
                      ...spec,
                      triggers: [...spec.triggers, createDefaultTrigger(kind)],
                    })
                  }
                >
                  <PlusIcon />
                  <span>{kind}</span>
                </Button>
              ))}
            </div>
          </div>

          {spec.triggers.length === 0 ? (
            <p className="text-xs text-muted-foreground">当前仅支持通过 UI / RPC 手动触发运行。</p>
          ) : (
            <div className="space-y-2">
              {(() => {
                const counts = new Map<string, number>();
                return spec.triggers.map((trigger, position) => {
                  const occ = (counts.get(trigger.kind) ?? 0) + 1;
                  counts.set(trigger.kind, occ);
                  return (
                    <div
                      key={triggerIdentity(trigger, occ)}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/20 p-2.5"
                    >
                      <Badge size="sm" variant="info">
                        {trigger.kind}
                      </Badge>
                      {trigger.kind === "manual" ? (
                        <span className="flex-1 text-xs text-muted-foreground">
                          从控制台或移动端手动一键运行
                        </span>
                      ) : null}
                      {trigger.kind === "every" ? (
                        <input
                          type="text"
                          className={`${INPUT_CLASS} w-44 font-mono`}
                          value={trigger.interval}
                          onChange={(e) =>
                            patchTrigger(position, {
                              ...trigger,
                              interval: e.target.value || "5 minutes",
                            })
                          }
                        />
                      ) : null}
                      {trigger.kind === "daily" ? (
                        <input
                          type="text"
                          className={`${INPUT_CLASS} w-32 font-mono`}
                          value={trigger.timeOfDay}
                          onChange={(e) =>
                            patchTrigger(position, {
                              ...trigger,
                              timeOfDay: e.target.value || "09:00",
                            })
                          }
                        />
                      ) : null}
                      {trigger.kind === "webhook" ? (
                        <>
                          <input
                            type="text"
                            className={`${INPUT_CLASS} w-40 font-mono`}
                            placeholder="hook name"
                            value={trigger.name}
                            onChange={(e) =>
                              patchTrigger(position, {
                                ...trigger,
                                name: e.target.value || "hook",
                              })
                            }
                          />
                          <input
                            type="text"
                            className={`${INPUT_CLASS} min-w-0 flex-1 font-mono`}
                            placeholder="幂等键路径 (如 body.deliveryId)"
                            value={trigger.idempotencyPath ?? ""}
                            onChange={(e) =>
                              patchTrigger(position, {
                                ...trigger,
                                ...(e.target.value
                                  ? { idempotencyPath: e.target.value }
                                  : { idempotencyPath: undefined }),
                              })
                            }
                          />
                        </>
                      ) : null}
                      {trigger.kind === "issues.opened" ||
                      trigger.kind === "pullRequests.opened" ? (
                        <input
                          type="text"
                          className={`${INPUT_CLASS} flex-1 font-mono`}
                          placeholder="project id"
                          value={trigger.project}
                          onChange={(e) =>
                            patchTrigger(position, {
                              ...trigger,
                              project: e.target.value || "default",
                            })
                          }
                        />
                      ) : null}
                      <Button
                        size="xs"
                        variant="ghost-destructive"
                        onClick={() =>
                          onChangeSpec({
                            ...spec,
                            triggers: spec.triggers.filter((_, i) => i !== position),
                          })
                        }
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                  );
                });
              })()}
            </div>
          )}
        </section>

        {/* Zero-Token Precheck */}
        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between border-b border-border pb-2">
            <div className="flex items-center gap-1.5">
              <ShieldAlertIcon className="size-4 text-success-foreground" />
              <div>
                <h2 className="text-sm font-semibold text-foreground">
                  零 Token 前置脚本门槛 (precheck)
                </h2>
                <p className="text-xs text-muted-foreground">
                  唤醒任何 AI Bot 前先执行确定性检查；非 0 退出即静默 skip，不消耗上下文与额度。
                </p>
              </div>
            </div>
            <select
              className={SELECT_CLASS}
              value={spec.precheck ? "on" : "off"}
              onChange={(event) => {
                if (event.target.value === "on" && !spec.precheck) {
                  onChangeSpec({
                    ...spec,
                    precheck: {
                      command: ["git", "status", "--porcelain"],
                      cwd: ".",
                      timeoutSeconds: 30,
                    },
                  });
                } else if (event.target.value === "off" && spec.precheck) {
                  onChangeSpec({ ...spec, precheck: undefined });
                }
              }}
            >
              <option value="off">未启用</option>
              <option value="on">已启用</option>
            </select>
          </div>

          {spec.precheck ? (
            <div className="space-y-2.5">
              <label className="block space-y-1">
                <span className="block text-xs font-medium text-muted-foreground">
                  无壳检查命令（每行一个参数）
                </span>
                <textarea
                  rows={3}
                  className={`${TEXTAREA_CLASS} font-mono`}
                  value={spec.precheck.command.join("\n")}
                  onChange={(event) => {
                    const cmd = event.target.value
                      .split(/\r?\n/)
                      .map((l) => l.trim())
                      .filter(Boolean);
                    if (cmd.length > 0 && spec.precheck) {
                      onChangeSpec({ ...spec, precheck: { ...spec.precheck, command: cmd } });
                    }
                  }}
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block space-y-1">
                  <span className="block text-xs font-medium text-muted-foreground">
                    工作目录 cwd
                  </span>
                  <input
                    type="text"
                    className={`${INPUT_CLASS} font-mono`}
                    value={spec.precheck.cwd}
                    onChange={(e) =>
                      spec.precheck &&
                      onChangeSpec({
                        ...spec,
                        precheck: { ...spec.precheck, cwd: e.target.value || "." },
                      })
                    }
                  />
                </label>
                <label className="flex cursor-pointer items-center gap-2 pt-5 text-xs text-foreground">
                  <input
                    type="checkbox"
                    checked={spec.precheck.runOnManual === true}
                    onChange={(e) =>
                      spec.precheck &&
                      onChangeSpec({
                        ...spec,
                        precheck: {
                          ...spec.precheck,
                          ...(e.target.checked
                            ? { runOnManual: true }
                            : { runOnManual: undefined }),
                        },
                      })
                    }
                  />
                  <span>手动触发时也执行 precheck</span>
                </label>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
