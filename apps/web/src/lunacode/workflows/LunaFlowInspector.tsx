import type {
  EnvironmentId,
  FlowAgentNode,
  FlowEdge,
  FlowEndNode,
  FlowGateNode,
  FlowNode,
  FlowOutputField,
  FlowScriptNode,
  FlowSpec,
  RuntimeMode,
} from "@t3tools/contracts";
import { ArrowRightIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { useProjects } from "../../state/entities";

const SELECT_CLASS =
  "h-7.5 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25";
const INPUT_CLASS =
  "h-7.5 w-full rounded-md border border-input bg-background px-2.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25";
const TEXTAREA_CLASS =
  "w-full rounded-md border border-input bg-background p-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25";

function updateNode(
  spec: FlowSpec,
  nodeId: string,
  updater: (node: FlowNode) => FlowNode,
): FlowSpec {
  return {
    ...spec,
    nodes: spec.nodes.map((node) => (node.id === nodeId ? updater(node) : node)),
  };
}

function updateEdge(
  spec: FlowSpec,
  edgeId: string,
  updater: (edge: FlowEdge) => FlowEdge,
): FlowSpec {
  return {
    ...spec,
    edges: spec.edges.map((edge) => (edge.id === edgeId ? updater(edge) : edge)),
  };
}

export function LunaFlowInspector({
  environmentId,
  spec,
  selectedNodeId,
  selectedEdgeId,
  onChangeSpec,
  onClearSelection,
}: {
  readonly environmentId: EnvironmentId;
  readonly spec: FlowSpec;
  readonly selectedNodeId: string | null;
  readonly selectedEdgeId: string | null;
  readonly onChangeSpec: (next: FlowSpec) => void;
  readonly onClearSelection: () => void;
}) {
  const allProjects = useProjects();
  const envProjects = allProjects.filter((project) => project.environmentId === environmentId);

  const selectedNode =
    selectedNodeId === null
      ? null
      : (spec.nodes.find((node) => node.id === selectedNodeId) ?? null);
  const selectedEdge =
    selectedEdgeId === null
      ? null
      : (spec.edges.find((edge) => edge.id === selectedEdgeId) ?? null);

  if (selectedEdge !== null) {
    return (
      <aside className="flex w-full shrink-0 flex-col gap-3 rounded-xl border border-border bg-card p-3.5 lg:w-88">
        <div className="flex items-center justify-between gap-2 border-b border-border pb-2.5">
          <div className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-foreground">
            <Badge size="sm" variant={selectedEdge.isLoop ? "warning" : "outline"}>
              {selectedEdge.isLoop ? "回流边" : "转移边"}
            </Badge>
            <span className="truncate font-mono">{selectedEdge.from}</span>
            <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate font-mono">{selectedEdge.to}</span>
          </div>
          <Button
            size="xs"
            variant="ghost-destructive"
            onClick={() => {
              onChangeSpec({
                ...spec,
                edges: spec.edges.filter((e) => e.id !== selectedEdge.id),
              });
              onClearSelection();
            }}
          >
            <Trash2Icon />
            <span>删除</span>
          </Button>
        </div>

        <label className="space-y-1">
          <span className="block text-xs font-medium text-muted-foreground">
            条件表达式（安全受限语法）
          </span>
          <input
            type="text"
            className={`${INPUT_CLASS} font-mono`}
            placeholder="例如 nodes.review.value.approved == true"
            value={selectedEdge.when ?? ""}
            onChange={(event) => {
              const raw = event.target.value;
              onChangeSpec(
                updateEdge(spec, selectedEdge.id, (edge) => ({
                  ...edge,
                  ...(raw.trim().length > 0 ? { when: raw } : { when: undefined }),
                })),
              );
            }}
          />
        </label>

        <div className="flex flex-wrap gap-1">
          {[
            { label: "无条件通过", expr: "" },
            { label: "评审通过", expr: "nodes.review.value.approved == true" },
            { label: "评审打回", expr: "!nodes.review.value.approved" },
            { label: "分支失败", expr: "outcome == 'failed'" },
          ].map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="cursor-pointer rounded-md border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground"
              onClick={() =>
                onChangeSpec(
                  updateEdge(spec, selectedEdge.id, (edge) => ({
                    ...edge,
                    ...(preset.expr ? { when: preset.expr } : { when: undefined }),
                  })),
                )
              }
            >
              {preset.label}
            </button>
          ))}
        </div>

        {selectedEdge.from !== "trigger" ? (
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-muted/30 p-2.5 text-xs">
            <input
              type="checkbox"
              checked={selectedEdge.isLoop === true}
              onChange={(event) => {
                const checked = event.target.checked;
                onChangeSpec(
                  updateEdge(spec, selectedEdge.id, (edge) => ({
                    ...edge,
                    ...(checked ? { isLoop: true } : { isLoop: undefined }),
                  })),
                );
              }}
            />
            <span className="text-foreground">标记为有界回流边（受 maxHops 熔断保护）</span>
          </label>
        ) : null}
      </aside>
    );
  }

  if (selectedNode === null) {
    return (
      <aside className="flex w-full shrink-0 flex-col justify-center gap-2 rounded-xl border border-dashed border-border bg-card/40 p-5 text-center lg:w-88">
        <p className="text-sm font-medium text-foreground">节点与连线检查器</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          在左侧画布点选任意节点或连线即可编辑其 Bot 角色、Worktree
          策略、条件表达式或结构化返回值；或点击工具栏按钮新增节点与连线。
        </p>
      </aside>
    );
  }

  const removeNode = () => {
    onChangeSpec({
      ...spec,
      nodes: spec.nodes.filter((n) => n.id !== selectedNode.id),
      edges: spec.edges.filter((e) => e.from !== selectedNode.id && e.to !== selectedNode.id),
    });
    onClearSelection();
  };

  return (
    <aside className="scrollbar-gutter-both flex w-full shrink-0 flex-col gap-3 overflow-y-auto rounded-xl border border-border bg-card p-3.5 lg:w-88">
      <div className="flex items-center justify-between gap-2 border-b border-border pb-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <Badge size="sm" variant="info">
            {selectedNode.kind}
          </Badge>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {selectedNode.id}
          </span>
        </div>
        <Button size="xs" variant="ghost-destructive" onClick={removeNode}>
          <Trash2Icon />
          <span>删除节点</span>
        </Button>
      </div>

      <label className="space-y-1">
        <span className="block text-xs font-medium text-muted-foreground">显示名称</span>
        <input
          type="text"
          aria-label="节点名称"
          className={INPUT_CLASS}
          value={selectedNode.label}
          onChange={(event) => {
            const label = event.target.value;
            onChangeSpec(
              updateNode(spec, selectedNode.id, (n) => ({
                ...n,
                label,
              })),
            );
          }}
        />
      </label>

      {selectedNode.kind === "agent" ? (
        <AgentInspectorFields
          spec={spec}
          node={selectedNode}
          projects={envProjects}
          onChange={(updated) => onChangeSpec(updateNode(spec, selectedNode.id, () => updated))}
        />
      ) : null}

      {selectedNode.kind === "gate" ? (
        <GateInspectorFields
          node={selectedNode}
          onChange={(updated) => onChangeSpec(updateNode(spec, selectedNode.id, () => updated))}
        />
      ) : null}

      {selectedNode.kind === "script" ? (
        <ScriptInspectorFields
          node={selectedNode}
          onChange={(updated) => onChangeSpec(updateNode(spec, selectedNode.id, () => updated))}
        />
      ) : null}

      {selectedNode.kind === "end" ? (
        <EndInspectorFields
          node={selectedNode}
          onChange={(updated) => onChangeSpec(updateNode(spec, selectedNode.id, () => updated))}
        />
      ) : null}
    </aside>
  );
}

function AgentInspectorFields({
  spec,
  node,
  projects,
  onChange,
}: {
  readonly spec: FlowSpec;
  readonly node: FlowAgentNode;
  readonly projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly onChange: (next: FlowAgentNode) => void;
}) {
  const botKeys = Object.keys(spec.bots);
  const upstreamAgents = spec.nodes.filter(
    (candidate): candidate is FlowAgentNode =>
      candidate.kind === "agent" && candidate.id !== node.id,
  );
  const hasMatchingProject = projects.some(
    (p) => p.id === node.project || p.title === node.project,
  );
  const returns = node.returns ?? [];

  const updateField = (idx: number, patch: Partial<FlowOutputField>) => {
    const nextReturns = returns.map((item, i) => (i === idx ? { ...item, ...patch } : item));
    onChange({ ...node, returns: nextReturns });
  };

  return (
    <div className="space-y-3">
      <label className="block space-y-1">
        <span className="block text-xs font-medium text-muted-foreground">执行 Bot 角色</span>
        <select
          className={SELECT_CLASS}
          value={node.botId}
          onChange={(event) => onChange({ ...node, botId: event.target.value })}
        >
          {botKeys.map((key) => (
            <option key={key} value={key}>
              {spec.bots[key]?.label ?? key} ({key})
            </option>
          ))}
        </select>
      </label>

      <label className="block space-y-1">
        <span className="block text-xs font-medium text-muted-foreground">目标项目</span>
        {projects.length > 0 ? (
          <select
            className={SELECT_CLASS}
            value={hasMatchingProject ? node.project : "__custom__"}
            onChange={(event) => {
              if (event.target.value !== "__custom__") {
                onChange({ ...node, project: event.target.value });
              }
            }}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
            {!hasMatchingProject ? (
              <option value="__custom__">自定义: {node.project}</option>
            ) : null}
          </select>
        ) : (
          <input
            type="text"
            className={INPUT_CLASS}
            value={node.project}
            onChange={(event) => onChange({ ...node, project: event.target.value })}
          />
        )}
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-muted-foreground">工作区策略</span>
          <select
            className={SELECT_CLASS}
            value={node.workspaceOverride ?? ""}
            onChange={(event) => {
              const val = event.target.value;
              onChange({
                ...node,
                ...(val === "root" || val === "worktree"
                  ? { workspaceOverride: val }
                  : { workspaceOverride: undefined }),
              });
            }}
          >
            <option value="">继承 Bot 默认</option>
            <option value="worktree">worktree 隔离</option>
            <option value="root">root 共享目录</option>
          </select>
        </label>

        <label className="block space-y-1">
          <span className="block text-xs font-medium text-muted-foreground">权限覆盖</span>
          <select
            className={SELECT_CLASS}
            value={node.runtimeModeOverride ?? ""}
            onChange={(event) => {
              const val = event.target.value;
              onChange({
                ...node,
                ...(val
                  ? { runtimeModeOverride: val as RuntimeMode }
                  : { runtimeModeOverride: undefined }),
              });
            }}
          >
            <option value="">继承 Bot 默认</option>
            <option value="approval-required">approval-required</option>
            <option value="auto-accept-edits">auto-accept-edits</option>
            <option value="auto">auto</option>
            <option value="full-access">full-access</option>
          </select>
        </label>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-muted-foreground">延续上游会话</span>
          <select
            className={SELECT_CLASS}
            value={node.continueThreadFromNodeId ?? ""}
            onChange={(event) => {
              const val = event.target.value;
              onChange({
                ...node,
                ...(val
                  ? { continueThreadFromNodeId: val }
                  : { continueThreadFromNodeId: undefined }),
              });
            }}
          >
            <option value="">开启新会话线程</option>
            {upstreamAgents.map((up) => (
              <option key={up.id} value={up.id}>
                复用 {up.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1">
          <span className="block text-xs font-medium text-muted-foreground">失败策略</span>
          <select
            className={SELECT_CLASS}
            value={node.onFailure ?? "pause"}
            onChange={(event) =>
              onChange({ ...node, onFailure: event.target.value as "pause" | "branch" })
            }
          >
            <option value="pause">暂停等待恢复</option>
            <option value="branch">走条件分支</option>
          </select>
        </label>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">Prompt 模板</span>
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              className="cursor-pointer rounded border border-border px-1.5 py-0.5 font-mono text-xs text-muted-foreground hover:text-foreground"
              onClick={() =>
                onChange({ ...node, promptTemplate: `${node.promptTemplate}\n{{payload.task}}` })
              }
            >
              +payload
            </button>
            {upstreamAgents[0] ? (
              <button
                type="button"
                className="cursor-pointer rounded border border-border px-1.5 py-0.5 font-mono text-xs text-muted-foreground hover:text-foreground"
                onClick={() =>
                  onChange({
                    ...node,
                    promptTemplate: `${node.promptTemplate}\n{{nodes.${upstreamAgents[0]!.id}.value}}`,
                  })
                }
              >
                +nodes.{upstreamAgents[0]!.id}
              </button>
            ) : null}
          </div>
        </div>
        <textarea
          rows={5}
          className={TEXTAREA_CLASS}
          value={node.promptTemplate}
          onChange={(event) => onChange({ ...node, promptTemplate: event.target.value })}
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">结构化输出字段</span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              onChange({
                ...node,
                returns: [...returns, { name: `field_${returns.length + 1}`, type: "string" }],
              })
            }
          >
            <PlusIcon />
            <span>字段</span>
          </Button>
        </div>
        {(() => {
          const seenNames = new Map<string, number>();
          return returns.map((field, pos) => {
            const occ = (seenNames.get(field.name) ?? 0) + 1;
            seenNames.set(field.name, occ);
            return (
              <div key={`${field.name}:${occ}`} className="flex items-center gap-1.5">
                <input
                  type="text"
                  className={`${INPUT_CLASS} min-w-0 flex-1 font-mono`}
                  value={field.name}
                  onChange={(event) => updateField(pos, { name: event.target.value })}
                />
                <select
                  className="h-7.5 rounded-md border border-input bg-background px-1.5 text-xs text-foreground"
                  value={field.type}
                  onChange={(event) =>
                    updateField(pos, {
                      type: event.target.value as FlowOutputField["type"],
                    })
                  }
                >
                  <option value="string">string</option>
                  <option value="number">number</option>
                  <option value="boolean">boolean</option>
                  <option value="string[]">string[]</option>
                </select>
                <Button
                  size="xs"
                  variant="ghost-destructive"
                  aria-label="删除输出字段"
                  onClick={() => {
                    const filtered = returns.filter((_, i) => i !== pos);
                    onChange({
                      ...node,
                      ...(filtered.length > 0 ? { returns: filtered } : { returns: undefined }),
                    });
                  }}
                >
                  <Trash2Icon />
                </Button>
              </div>
            );
          });
        })()}
      </div>
    </div>
  );
}

function GateInspectorFields({
  node,
  onChange,
}: {
  readonly node: FlowGateNode;
  readonly onChange: (next: FlowGateNode) => void;
}) {
  return (
    <div className="space-y-3">
      <label className="block space-y-1">
        <span className="block text-xs font-medium text-muted-foreground">门禁模式</span>
        <select
          className={SELECT_CLASS}
          value={node.gateMode}
          onChange={(event) =>
            onChange({
              ...node,
              gateMode: event.target.value as FlowGateNode["gateMode"],
            })
          }
        >
          <option value="human">仅人工确认 (human)</option>
          <option value="coordinator_then_human">协调者汇总后人工拍板</option>
        </select>
      </label>

      <label className="block space-y-1">
        <span className="block text-xs font-medium text-muted-foreground">询问标题模板</span>
        <textarea
          rows={3}
          className={TEXTAREA_CLASS}
          value={node.titleTemplate}
          onChange={(event) => onChange({ ...node, titleTemplate: event.target.value })}
        />
      </label>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">审批选项</span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              onChange({
                ...node,
                choices: [...node.choices, { value: `选项 ${node.choices.length + 1}` }],
              })
            }
          >
            <PlusIcon />
            <span>选项</span>
          </Button>
        </div>
        {(() => {
          const seenChoices = new Map<string, number>();
          return node.choices.map((choice, pos) => {
            const occ = (seenChoices.get(choice.value) ?? 0) + 1;
            seenChoices.set(choice.value, occ);
            return (
              <div
                key={`${choice.value}:${occ}`}
                className="space-y-1 rounded-lg border border-border p-2"
              >
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    className={`${INPUT_CLASS} min-w-0 flex-1`}
                    value={choice.value}
                    onChange={(event) => {
                      const nextChoices = node.choices.map((c, i) =>
                        i === pos ? { ...c, value: event.target.value } : c,
                      );
                      onChange({ ...node, choices: nextChoices });
                    }}
                  />
                  {node.choices.length > 1 ? (
                    <Button
                      size="xs"
                      variant="ghost-destructive"
                      aria-label="删除选项"
                      onClick={() =>
                        onChange({
                          ...node,
                          choices: node.choices.filter((_, i) => i !== pos),
                        })
                      }
                    >
                      <Trash2Icon />
                    </Button>
                  ) : null}
                </div>
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={choice.requireReason === true}
                    onChange={(event) => {
                      const nextChoices = node.choices.map((c, i) =>
                        i === pos
                          ? {
                              ...c,
                              ...(event.target.checked
                                ? { requireReason: true }
                                : { requireReason: undefined }),
                            }
                          : c,
                      );
                      onChange({ ...node, choices: nextChoices });
                    }}
                  />
                  <span>选中时必填审批理由</span>
                </label>
              </div>
            );
          });
        })()}
      </div>
    </div>
  );
}

function ScriptInspectorFields({
  node,
  onChange,
}: {
  readonly node: FlowScriptNode;
  readonly onChange: (next: FlowScriptNode) => void;
}) {
  return (
    <div className="space-y-3">
      <label className="block space-y-1">
        <span className="block text-xs font-medium text-muted-foreground">
          无壳命令参数（每行一个 argv token，禁止模板变量）
        </span>
        <textarea
          rows={4}
          className={`${TEXTAREA_CLASS} font-mono`}
          value={node.command.join("\n")}
          onChange={(event) => {
            const parts = event.target.value
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter((line) => line.length > 0);
            if (parts.length > 0) {
              onChange({ ...node, command: parts });
            }
          }}
        />
      </label>

      <label className="block space-y-1">
        <span className="block text-xs font-medium text-muted-foreground">工作目录 cwd</span>
        <input
          type="text"
          className={`${INPUT_CLASS} font-mono`}
          value={node.cwd}
          onChange={(event) => onChange({ ...node, cwd: event.target.value || "." })}
        />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-muted-foreground">超时秒数</span>
          <input
            type="number"
            min={1}
            max={1800}
            className={INPUT_CLASS}
            value={node.timeoutSeconds ?? 120}
            onChange={(event) => {
              const parsed = Number(event.target.value);
              if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 1800) {
                onChange({ ...node, timeoutSeconds: parsed });
              }
            }}
          />
        </label>
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-muted-foreground">非零退出策略</span>
          <select
            className={SELECT_CLASS}
            value={node.onFailure ?? "pause"}
            onChange={(event) =>
              onChange({ ...node, onFailure: event.target.value as "pause" | "branch" })
            }
          >
            <option value="pause">暂停等待人工</option>
            <option value="branch">走条件分支</option>
          </select>
        </label>
      </div>
    </div>
  );
}

function EndInspectorFields({
  node,
  onChange,
}: {
  readonly node: FlowEndNode;
  readonly onChange: (next: FlowEndNode) => void;
}) {
  return (
    <div className="space-y-3">
      <label className="block space-y-1">
        <span className="block text-xs font-medium text-muted-foreground">结束结果类型</span>
        <select
          className={SELECT_CLASS}
          value={node.outcome}
          onChange={(event) =>
            onChange({ ...node, outcome: event.target.value as FlowEndNode["outcome"] })
          }
        >
          <option value="complete">完成 (complete)</option>
          <option value="stop">中止 (stop)</option>
          <option value="skip">跳过 (skip)</option>
        </select>
      </label>
      <label className="block space-y-1">
        <span className="block text-xs font-medium text-muted-foreground">结束说明模板</span>
        <textarea
          rows={3}
          className={TEXTAREA_CLASS}
          value={node.reasonTemplate ?? ""}
          onChange={(event) => {
            const val = event.target.value;
            onChange({
              ...node,
              ...(val.length > 0 ? { reasonTemplate: val } : { reasonTemplate: undefined }),
            });
          }}
        />
      </label>
    </div>
  );
}
