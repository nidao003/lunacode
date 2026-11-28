import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  buildLiveRunGraphOverlay,
  isFlowDefinitionFile,
  parseFlowSpecSafe,
} from "@t3tools/client-runtime/lunacode/workflow-flow";
import {
  type EnvironmentId,
  type FlowSpec,
  type WorkflowStep,
  type WorkflowSummary,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { PlayIcon, UsersIcon, WorkflowIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import type { WorkflowThreadTarget } from "../../components/workflows/WorkflowRunFeed";
import type { WorkflowRunNode } from "@t3tools/client-runtime/workflows";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { LunaFlowCanvas } from "./LunaFlowCanvas";
import { LunaLiveCrewPanel } from "./LunaLiveCrewPanel";

type RunViewTab = "timeline" | "graph" | "crew";

export function LunaWorkflowRunEnhancements({
  environmentId,
  node,
  steps,
  onOpenThread,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly node: WorkflowRunNode;
  readonly steps: ReadonlyArray<WorkflowStep> | undefined;
  readonly onOpenThread: (thread: WorkflowThreadTarget) => void;
  readonly children: ReactNode;
}) {
  const [tab, setTab] = useState<RunViewTab>("timeline");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  const definitionsQuery = useEnvironmentQuery(
    serverEnvironment.workflowDefinition({ environmentId, input: {} }),
  );

  // Match .flow.json definition by workflow name & exact version (fallback to same name).
  const flowFiles = (definitionsQuery.data?.files ?? []).filter((f) =>
    isFlowDefinitionFile(f.name),
  );
  let matchedSpec: FlowSpec | null = null;
  for (const file of flowFiles) {
    const parsed = parseFlowSpecSafe(file.source);
    if (!parsed.ok) continue;
    if (parsed.spec.name === node.run.workflow && parsed.spec.version === node.run.version) {
      matchedSpec = parsed.spec;
      break;
    }
    if (matchedSpec === null && parsed.spec.name === node.run.workflow) {
      matchedSpec = parsed.spec;
    }
  }

  const overlay = buildLiveRunGraphOverlay(matchedSpec, node.run, steps ?? [], node.questions);
  const displaySpec = matchedSpec ?? overlay.fallbackSpec;
  const selectedLiveState =
    selectedNodeId !== null ? (overlay.nodeStates[selectedNodeId] ?? null) : null;

  return (
    <div className="mt-3">
      {/* View Switcher Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2.5">
        <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="运行视图切换">
          <Button
            size="xs"
            role="tab"
            aria-selected={tab === "timeline"}
            variant={tab === "timeline" ? "secondary" : "ghost"}
            onClick={() => setTab("timeline")}
          >
            <span>时间线</span>
          </Button>
          <Button
            size="xs"
            role="tab"
            aria-selected={tab === "graph"}
            variant={tab === "graph" ? "secondary" : "ghost"}
            onClick={() => setTab("graph")}
          >
            <WorkflowIcon />
            <span>流程图</span>
          </Button>
          <Button
            size="xs"
            role="tab"
            aria-selected={tab === "crew"}
            variant={tab === "crew" ? "secondary" : "ghost"}
            onClick={() => setTab("crew")}
          >
            <UsersIcon />
            <span>Bot 协作 ({overlay.crew.length})</span>
          </Button>
        </div>

        <div className="flex items-center gap-1.5">
          {node.questions.length > 0 ? (
            <Badge size="sm" variant="warning">
              {node.questions.length} 项待审批
            </Badge>
          ) : null}
          {overlay.totalLoopHops > 0 ? (
            <Badge size="sm" variant="info">
              回流 {overlay.totalLoopHops} 轮
            </Badge>
          ) : null}
        </div>
      </div>

      {tab === "timeline" ? (
        children
      ) : tab === "graph" ? (
        <div className="mt-4 space-y-3">
          {displaySpec && displaySpec.nodes.length > 0 ? (
            <div className="flex min-h-80 flex-col">
              <LunaFlowCanvas
                spec={displaySpec}
                editable={false}
                selectedNodeId={selectedNodeId}
                selectedEdgeId={selectedEdgeId}
                liveOverlay={overlay}
                onSelectNode={(id) => {
                  setSelectedNodeId(id);
                  const live = id ? overlay.nodeStates[id] : undefined;
                  if (live?.threadId) {
                    onOpenThread({
                      threadId: live.threadId,
                      environmentId: live.environmentId ?? null,
                    });
                  }
                }}
                onSelectEdge={setSelectedEdgeId}
              />
            </div>
          ) : (
            <p className="rounded-xl border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
              暂无可绘制的步骤节点。
            </p>
          )}

          {selectedLiveState ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card p-3 text-xs">
              <div className="min-w-0 space-y-0.5">
                <p className="font-semibold text-foreground">
                  {selectedLiveState.label} (
                  {selectedLiveState.latestStepName ?? selectedLiveState.nodeId})
                </p>
                {selectedLiveState.summary ? (
                  <p className="line-clamp-2 text-muted-foreground">{selectedLiveState.summary}</p>
                ) : null}
              </div>
              {selectedLiveState.threadId ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    onOpenThread({
                      threadId: selectedLiveState.threadId!,
                      environmentId: selectedLiveState.environmentId ?? null,
                    })
                  }
                >
                  打开 Bot 会话
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <LunaLiveCrewPanel
          environmentId={environmentId}
          overlay={overlay}
          questions={node.questions}
          onOpenThread={onOpenThread}
        />
      )}
    </div>
  );
}

export function LunaQuickRunBar({
  environmentId,
  workflows,
  onStarted,
  onOpenDefinitions,
}: {
  readonly environmentId: EnvironmentId;
  readonly workflows: ReadonlyArray<WorkflowSummary>;
  readonly onStarted: (runId: string) => void;
  readonly onOpenDefinitions: () => void;
}) {
  const [selected, setSelected] = useState<string>(workflows[0]?.name ?? "");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canStart = useAtomValue(serverEnvironment.startWorkflowRun.permissionAtom(environmentId));
  const startRun = useAtomCommand(serverEnvironment.startWorkflowRun, {
    label: "quick start workflow",
  });

  if (workflows.length === 0) return null;

  const activeName = workflows.some((w) => w.name === selected) ? selected : workflows[0]!.name;

  const launch = async () => {
    if (starting || !canStart) return;
    setStarting(true);
    setError(null);
    const res = await startRun({
      environmentId,
      input: { workflow: activeName },
    });
    setStarting(false);
    if (res._tag === "Failure") {
      setError(isAtomCommandInterrupted(res) ? null : String(squashAtomCommandFailure(res)));
      return;
    }
    onStarted(res.value.runId);
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-card/50 px-3 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-muted-foreground">快速启动</span>
        <select
          aria-label="选择要启动的工作流"
          className="h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:border-ring"
          value={activeName}
          onChange={(e) => setSelected(e.target.value)}
        >
          {workflows.map((w) => (
            <option key={`${w.name}@${w.version}`} value={w.name}>
              {w.name} (v{w.version})
            </option>
          ))}
        </select>
        <Button
          size="xs"
          variant="outline"
          disabled={starting || !canStart}
          onClick={() => void launch()}
        >
          <PlayIcon />
          <span>{starting ? "启动中..." : "立即运行"}</span>
        </Button>
        {error ? <span className="text-destructive-foreground">{error}</span> : null}
      </div>

      <Button size="xs" variant="ghost" onClick={onOpenDefinitions}>
        <WorkflowIcon />
        <span>可视化编排</span>
      </Button>
    </div>
  );
}
