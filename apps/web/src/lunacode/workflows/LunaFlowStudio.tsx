import {
  buildChatEditPrompt,
  computeFlowDryRunClient,
  createStarterFlowSpec,
  formatFlowSpecJson,
  nextFlowVersionTarget,
  parseFlowSpecSafe,
  validateFlowClient,
} from "@t3tools/client-runtime/lunacode/workflow-flow";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type FlowNode,
  type FlowSpec,
  type WorkflowDefinitionProblem,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  Code2Icon,
  CopyPlusIcon,
  FlaskConicalIcon,
  MessageSquareCodeIcon,
  PlayIcon,
  SaveIcon,
  Trash2Icon,
  UsersIcon,
  WorkflowIcon,
  WrenchIcon,
} from "lucide-react";
import { useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  diskChange,
  type DiskChange,
} from "../../components/workflows/WorkflowDefinitionEditor.logic";
import { LunaFlowCanvas } from "./LunaFlowCanvas";
import { LunaFlowDryRunDialog } from "./LunaFlowDryRunDialog";
import { LunaFlowInspector } from "./LunaFlowInspector";
import { LunaFlowRolesPanel } from "./LunaFlowRolesPanel";
import { LunaFlowSettingsPanel } from "./LunaFlowSettingsPanel";

type StudioTab = "canvas" | "roles" | "settings" | "json";

const DESKTOP_HEADER_QUERY = "(min-width: 1024px)";

function subscribeDesktopHeader(onStoreChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const media = window.matchMedia(DESKTOP_HEADER_QUERY);
  media.addEventListener("change", onStoreChange);
  return () => media.removeEventListener("change", onStoreChange);
}

function getDesktopHeaderSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true;
  }
  return window.matchMedia(DESKTOP_HEADER_QUERY).matches;
}

function getDesktopHeaderServerSnapshot(): boolean {
  return true;
}

function createDefaultNode(
  spec: FlowSpec,
  kind: FlowNode["kind"],
  fallbackProject: string,
): FlowNode {
  const existingIds = new Set(spec.nodes.map((n) => n.id));
  let idx = spec.nodes.length + 1;
  let id = `${kind}_${idx}`;
  while (existingIds.has(id)) {
    idx += 1;
    id = `${kind}_${idx}`;
  }
  const firstBotId = Object.keys(spec.bots)[0] ?? "worker";

  switch (kind) {
    case "agent":
      return {
        id,
        kind: "agent",
        label: `Agent ${idx}`,
        botId: firstBotId,
        project: fallbackProject,
        promptTemplate: "请完成分配给本节点的任务：\n{{payload.task}}",
      };
    case "gate":
      return {
        id,
        kind: "gate",
        label: `人工审批 ${idx}`,
        gateMode: "human",
        titleTemplate: "请确认是否继续流程？",
        choices: [{ value: "批准继续" }, { value: "拒绝中止", requireReason: true }],
      };
    case "script":
      return {
        id,
        kind: "script",
        label: `检查脚本 ${idx}`,
        command: ["git", "status", "--short"],
        cwd: ".",
        timeoutSeconds: 60,
      };
    case "end":
      return {
        id,
        kind: "end",
        label: `结束 ${idx}`,
        outcome: "complete",
      };
  }
}

export function LunaFlowStudio({
  environmentId,
  name,
  source,
  revision: _revision,
  onDisk,
  offline,
  onDelete,
  onClose,
  onOpenFile,
  actions,
}: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly source: string;
  readonly revision: number;
  readonly onDisk: ReadonlyArray<WorkflowDefinitionProblem>;
  readonly offline: boolean;
  readonly onDelete?: (() => Promise<boolean>) | undefined;
  readonly onClose: () => void;
  readonly onOpenFile: (file: string | null) => void;
  readonly actions: HTMLElement | null;
}) {
  const navigate = useNavigate();
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? [];

  const canSave = useAtomValue(
    serverEnvironment.saveWorkflowDefinition.permissionAtom(environmentId),
  );
  const canStart = useAtomValue(serverEnvironment.startWorkflowRun.permissionAtom(environmentId));
  const save = useAtomCommand(serverEnvironment.saveWorkflowDefinition, {
    label: "flow studio save",
  });
  const startRun = useAtomCommand(serverEnvironment.startWorkflowRun, {
    label: "flow studio start",
  });

  const [baseline, setBaseline] = useState(source);
  const [seen, setSeen] = useState(source);
  const [staleAt, setStaleAt] = useState<DiskChange | null>(null);
  const [text, setText] = useState(source);
  const [savingText, setSavingText] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saveProblems, setSaveProblems] = useState<ReadonlyArray<WorkflowDefinitionProblem>>([]);
  const [deleting, setDeleting] = useState(false);
  const [running, setRunning] = useState(false);

  const [tab, setTab] = useState<StudioTab>(() =>
    parseFlowSpecSafe(source).ok ? "canvas" : "json",
  );
  const [draftSpec, setDraftSpec] = useState<FlowSpec | null>(() => {
    const res = parseFlowSpecSafe(source);
    return res.ok ? res.spec : null;
  });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [dryRunOpen, setDryRunOpen] = useState(false);
  const [chatGoalOpen, setChatGoalOpen] = useState(false);
  const [chatGoal, setChatGoal] = useState("");

  const dirty = text !== baseline;

  if (source !== seen) {
    setSeen(source);
    const change = diskChange({ source, baseline, dirty, saving: savingText });
    if (change === "stale") {
      setStaleAt({ source });
    } else if (change === "follow") {
      setBaseline(source);
      setText(source);
      const nextParsed = parseFlowSpecSafe(source);
      setDraftSpec(nextParsed.ok ? nextParsed.spec : null);
      setStaleAt(null);
      setSaveProblems([]);
    }
  }

  const parsed = parseFlowSpecSafe(text);
  const spec = tab === "json" ? (parsed.ok ? parsed.spec : null) : draftSpec;
  const validationIssues = spec ? validateFlowClient(spec) : [];
  const errorCount = validationIssues.filter((i) => i.severity === "error").length;
  const warningCount = validationIssues.filter((i) => i.severity === "warning").length;

  const commitSpec = (next: FlowSpec) => {
    setDraftSpec(next);
    setText(formatFlowSpecJson(next));
    setFailure(null);
  };

  const persist = async (targetFile: string, content: string, openAfter = false) => {
    if (offline || !canSave || savingText !== null) return false;
    setSavingText(content);
    setFailure(null);
    const result = await save({
      environmentId,
      input: { name: targetFile, source: content },
    });
    setSavingText(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setFailure(String(squashAtomCommandFailure(result)));
      }
      return false;
    }
    if (result.value.changed) {
      if (targetFile === name) {
        setBaseline(content);
        setText(content);
        setStaleAt(null);
      }
    }
    setSaveProblems(result.value.problems);
    if (result.value.changed && openAfter) {
      onOpenFile(targetFile);
    }
    return result.value.changed;
  };

  const handleSave = async () => {
    if (!parsed.ok) {
      setFailure(
        parsed.line !== null
          ? `第 ${parsed.line} 行 JSON/Schema 错误：${parsed.error}`
          : parsed.error,
      );
      return;
    }
    if (errorCount > 0) {
      setDryRunOpen(true);
      return;
    }
    await persist(name, formatFlowSpecJson(parsed.spec));
  };

  const handleCreateNextVersion = async () => {
    if (!spec) return;
    if (errorCount > 0) {
      setDryRunOpen(true);
      return;
    }
    const target = nextFlowVersionTarget(name, spec);
    await persist(target.fileName, formatFlowSpecJson(target.spec), true);
  };

  const handleRunNow = async () => {
    if (!spec || running || !canStart) return;
    if (errorCount > 0) {
      setDryRunOpen(true);
      return;
    }
    if (dirty) {
      const saved = await persist(name, formatFlowSpecJson(spec));
      if (!saved) return;
    }
    setRunning(true);
    setFailure(null);
    const res = await startRun({
      environmentId,
      input: { workflow: spec.name },
    });
    setRunning(false);
    if (res._tag === "Failure") {
      if (!isAtomCommandInterrupted(res)) {
        setFailure(String(squashAtomCommandFailure(res)));
      }
      return;
    }
    void navigate({
      to: "/workflows",
      search: { env: environmentId, run: res.value.runId },
    });
  };

  const handleOpenChatEdit = () => {
    if (!spec) return;
    const prompt = buildChatEditPrompt(name, spec, chatGoal);
    setChatGoalOpen(false);
    void navigate({
      to: "/new",
      search: { prompt } as never,
    });
  };

  const handleDelete = async () => {
    if (!onDelete || deleting) return;
    setDeleting(true);
    const ok = await onDelete();
    setDeleting(false);
    if (ok) onClose();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void handleSave();
    }
  };

  const addNode = (kind: FlowNode["kind"]) => {
    if (!spec) return;
    const defaultProject = projects[0]?.id ?? "default-project";
    const created = createDefaultNode(spec, kind, defaultProject);
    const sourceId = selectedNodeId ?? (spec.nodes.length === 0 ? "trigger" : null);
    const nextEdges =
      sourceId !== null
        ? [
            ...spec.edges,
            {
              id: `e_${spec.edges.length + 1}_${Date.now().toString(36)}`,
              from: sourceId,
              to: created.id,
            },
          ]
        : spec.edges;
    commitSpec({
      ...spec,
      nodes: [...spec.nodes, created],
      edges: nextEdges,
    });
    setSelectedEdgeId(null);
    setSelectedNodeId(created.id);
  };

  const addEdge = (from: string, to: string) => {
    if (!spec) return;
    const exists = spec.edges.some((e) => e.from === from && e.to === to);
    if (exists) return;
    const id = `e_${spec.edges.length + 1}_${Date.now().toString(36)}`;
    commitSpec({
      ...spec,
      edges: [...spec.edges, { id, from, to }],
    });
    setSelectedNodeId(null);
    setSelectedEdgeId(id);
  };

  const resetToStarter = () => {
    const defaultProvider = providers.find((p) => p.enabled && p.models.length > 0);
    const defaultModel =
      defaultProvider?.models.find((m) => m.isDefault) ?? defaultProvider?.models[0];
    const starter = createStarterFlowSpec({
      name: name.replace(/\.flow\.json$/i, ""),
      ...(projects[0]?.id ? { project: projects[0].id } : {}),
      ...(defaultProvider?.instanceId ? { providerInstanceId: defaultProvider.instanceId } : {}),
      ...(defaultModel?.slug ? { model: defaultModel.slug } : {}),
    });
    commitSpec(starter);
    setTab("canvas");
  };

  const headerActions = (
    <div className="flex flex-wrap items-center gap-1.5">
      {spec ? (
        <Badge
          size="sm"
          variant={errorCount > 0 ? "error" : warningCount > 0 ? "warning" : "success"}
        >
          {errorCount > 0
            ? `${errorCount} 个错误`
            : warningCount > 0
              ? `可用 · ${warningCount} 提示`
              : "校验通过"}
        </Badge>
      ) : (
        <Badge size="sm" variant="error">
          JSON 解析失败
        </Badge>
      )}
      {dirty ? (
        <Badge size="sm" variant="outline">
          未保存
        </Badge>
      ) : null}
      {spec ? (
        <>
          <Button size="xs" variant="outline" onClick={() => setDryRunOpen(true)}>
            <FlaskConicalIcon />
            <span>预演</span>
          </Button>
          <Button size="xs" variant="outline" onClick={() => setChatGoalOpen(!chatGoalOpen)}>
            <MessageSquareCodeIcon />
            <span>在对话中修改</span>
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={offline || !canSave || savingText !== null}
            onClick={() => void handleCreateNextVersion()}
          >
            <CopyPlusIcon />
            <span>创建 v{spec.version + 1}</span>
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={offline || !canStart || running}
            onClick={() => void handleRunNow()}
          >
            <PlayIcon />
            <span>{running ? "启动中..." : "立即运行"}</span>
          </Button>
        </>
      ) : null}
      <Button
        size="xs"
        variant="default"
        disabled={offline || !canSave || savingText !== null}
        onClick={() => void handleSave()}
      >
        <SaveIcon />
        <span>{savingText !== null ? "保存中..." : "保存"}</span>
      </Button>
      {onDelete ? (
        <Button
          size="xs"
          variant="ghost-destructive"
          disabled={offline || !canSave || deleting}
          onClick={() => void handleDelete()}
        >
          <Trash2Icon />
        </Button>
      ) : null}
    </div>
  );

  const visibleProblems = saveProblems.length > 0 ? saveProblems : onDisk;
  const canPortalHeaderActions = useSyncExternalStore(
    subscribeDesktopHeader,
    getDesktopHeaderSnapshot,
    getDesktopHeaderServerSnapshot,
  );
  const portalTarget = canPortalHeaderActions ? actions : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={handleKeyDown}>
      {portalTarget ? createPortal(headerActions, portalTarget) : null}

      {/* Secondary Studio Nav Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-card/50 px-4 py-2">
        <div className="flex items-center gap-2">
          <Button size="xs" variant="ghost" onClick={onClose}>
            <ArrowLeftIcon />
            <span>文件列表</span>
          </Button>
          <span aria-hidden className="h-4 w-px bg-border" />
          <span className="font-mono text-xs font-semibold text-foreground">{name}</span>
          {spec ? (
            <Badge size="sm" variant="info">
              {spec.name} · v{spec.version}
            </Badge>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {[
            { id: "canvas" as const, label: "画布与编排", icon: WorkflowIcon, disabled: !spec },
            {
              id: "roles" as const,
              label: `Bot 角色 (${spec ? Object.keys(spec.bots).length : 0})`,
              icon: UsersIcon,
              disabled: !spec,
            },
            { id: "settings" as const, label: "触发与安全", icon: WrenchIcon, disabled: !spec },
            { id: "json" as const, label: "JSON 源码", icon: Code2Icon, disabled: false },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <Button
                key={item.id}
                size="xs"
                variant={tab === item.id ? "secondary" : "ghost"}
                disabled={item.disabled}
                onClick={() => setTab(item.id)}
              >
                <Icon />
                <span>{item.label}</span>
              </Button>
            );
          })}
        </div>
      </div>

      {!portalTarget ? (
        <div className="border-b border-border bg-muted/20 px-4 py-2">{headerActions}</div>
      ) : null}

      {/* Chat-Assisted Modification Bar */}
      {chatGoalOpen && spec ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-info/8 px-4 py-2.5 text-xs">
          <input
            type="text"
            className="h-7.5 min-w-48 flex-1 rounded-md border border-input bg-background px-2.5 text-xs text-foreground outline-none focus-visible:border-ring"
            placeholder="描述你想让 AI Agent 怎么修改这个工作流（可选，例如：增加一个安全审计节点）"
            value={chatGoal}
            onChange={(e) => setChatGoal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleOpenChatEdit();
            }}
          />
          <Button size="xs" variant="default" onClick={handleOpenChatEdit}>
            <MessageSquareCodeIcon />
            <span>带着上下文发起对话</span>
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setChatGoalOpen(false)}>
            <span>取消</span>
          </Button>
        </div>
      ) : null}

      {/* Stale Disk Conflict Banner */}
      {staleAt ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-xs"
        >
          <span className="text-warning-foreground">
            磁盘上的文件已在外部被修改（例如 Agent 通过 MCP 工具更新）。
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setBaseline(staleAt.source);
                setText(staleAt.source);
                setStaleAt(null);
              }}
            >
              重新加载磁盘版本
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setStaleAt(null)}>
              保留当前草稿
            </Button>
          </div>
        </div>
      ) : null}

      {/* Failure / Problems Banner */}
      {failure || visibleProblems.length > 0 ? (
        <div
          role="alert"
          className="border-b border-destructive/35 bg-destructive/8 px-4 py-2 text-xs"
        >
          {failure ? <p className="font-medium text-destructive-foreground">{failure}</p> : null}
          {visibleProblems.map((p) => (
            <p key={`${p.line ?? "x"}:${p.message}`} className="text-destructive-foreground">
              {p.line !== undefined ? `第 ${p.line} 行：` : ""}
              {p.message}
            </p>
          ))}
        </div>
      ) : null}

      {/* Studio Main Workspace */}
      {tab === "json" || spec === null ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          {!parsed.ok ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/8 p-3 text-xs">
              <span className="text-destructive-foreground">
                {parsed.line !== null ? `第 ${parsed.line} 行：` : ""}
                {parsed.error}
              </span>
              <Button size="xs" variant="outline" onClick={resetToStarter}>
                重置为多 Bot 模板
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <CheckCircle2Icon className="size-3.5 text-success-foreground" />
                JSON 与 FlowSpec v1 校验合法，可随时切换回可视化画布。
              </span>
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  if (parsed.ok) commitSpec(parsed.spec);
                }}
              >
                格式化 JSON
              </Button>
            </div>
          )}
          <textarea
            aria-label="Flow JSON source"
            className="min-h-0 flex-1 rounded-xl border border-input bg-card p-3 font-mono text-xs leading-relaxed text-foreground outline-none focus-visible:border-ring"
            value={text}
            onChange={(e) => {
              const raw = e.target.value;
              setText(raw);
              const nextParsed = parseFlowSpecSafe(raw);
              if (nextParsed.ok) setDraftSpec(nextParsed.spec);
            }}
          />
        </div>
      ) : tab === "canvas" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 sm:p-4 lg:flex-row">
          <LunaFlowCanvas
            spec={spec}
            editable
            selectedNodeId={selectedNodeId}
            selectedEdgeId={selectedEdgeId}
            onSelectNode={setSelectedNodeId}
            onSelectEdge={setSelectedEdgeId}
            onAddNode={addNode}
            onAddEdge={addEdge}
          />
          <LunaFlowInspector
            environmentId={environmentId}
            spec={spec}
            selectedNodeId={selectedNodeId}
            selectedEdgeId={selectedEdgeId}
            onChangeSpec={commitSpec}
            onClearSelection={() => {
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
            }}
          />
        </div>
      ) : tab === "roles" ? (
        <LunaFlowRolesPanel environmentId={environmentId} spec={spec} onChangeSpec={commitSpec} />
      ) : (
        <LunaFlowSettingsPanel spec={spec} onChangeSpec={commitSpec} />
      )}

      {spec ? (
        <LunaFlowDryRunDialog
          open={dryRunOpen}
          spec={spec}
          report={computeFlowDryRunClient(spec)}
          onOpenChange={setDryRunOpen}
          onJumpToNode={(nodeId) => {
            setTab("canvas");
            setSelectedEdgeId(null);
            setSelectedNodeId(nodeId);
          }}
        />
      ) : null}
    </div>
  );
}
