import {
  computeFlowLayout,
  type LiveFlowOverlay,
  type LiveNodeStatus,
} from "@t3tools/client-runtime/lunacode/workflow-flow";
import type { FlowNode, FlowSpec } from "@t3tools/contracts";
import {
  BotIcon,
  FlagIcon,
  GitBranchIcon,
  LayersIcon,
  Link2Icon,
  PlayIcon,
  ShieldCheckIcon,
  TerminalIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";

const STATUS_BADGE_MAP: Record<
  LiveNodeStatus,
  {
    readonly label: string;
    readonly variant: "default" | "info" | "warning" | "success" | "error" | "outline";
  }
> = {
  pending: { label: "待运行", variant: "outline" },
  running: { label: "执行中", variant: "info" },
  waiting: { label: "待审批", variant: "warning" },
  completed: { label: "已完成", variant: "success" },
  failed: { label: "失败", variant: "error" },
  skipped: { label: "已跳过", variant: "outline" },
};

function NodeKindIcon({ kind }: { readonly kind: FlowNode["kind"] }) {
  if (kind === "agent") return <BotIcon className="size-3.5 shrink-0 text-info-foreground" />;
  if (kind === "gate") {
    return <ShieldCheckIcon className="size-3.5 shrink-0 text-warning-foreground" />;
  }
  if (kind === "script")
    return <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  return <FlagIcon className="size-3.5 shrink-0 text-success-foreground" />;
}

function nodeKindTag(kind: FlowNode["kind"]): string {
  if (kind === "agent") return "Agent";
  if (kind === "gate") return "审批门";
  if (kind === "script") return "脚本";
  return "结束";
}

function nodeSubLabel(spec: FlowSpec, node: FlowNode): string {
  if (node.kind === "agent") {
    const bot = spec.bots[node.botId];
    const ws = node.workspaceOverride ?? bot?.workspace ?? "root";
    return `${bot?.label ?? node.botId} · ${ws}`;
  }
  if (node.kind === "gate") {
    return node.gateMode === "coordinator_then_human"
      ? `协调者优先 · ${node.choices.length} 选项`
      : `人工确认 · ${node.choices.length} 选项`;
  }
  if (node.kind === "script") {
    return node.command.slice(0, 2).join(" ");
  }
  return node.outcome === "complete"
    ? "成功收口"
    : node.outcome === "stop"
      ? "中止停止"
      : "条件跳过";
}

function cardSurfaceClass(
  kind: FlowNode["kind"],
  selected: boolean,
  connectSource: boolean,
  liveStatus?: LiveNodeStatus,
): string {
  if (connectSource) {
    return "border-warning bg-warning/10 ring-2 ring-warning/40";
  }
  if (selected) {
    return "border-primary bg-card ring-2 ring-primary/35 shadow-sm";
  }
  if (liveStatus === "running") return "border-info/55 bg-info/8 shadow-xs";
  if (liveStatus === "waiting") return "border-warning/65 bg-warning/10 shadow-xs";
  if (liveStatus === "failed") return "border-destructive/60 bg-destructive/8 shadow-xs";
  if (liveStatus === "completed") return "border-success/50 bg-success/8";
  if (liveStatus === "skipped") return "border-border/60 bg-muted/40 opacity-70";
  if (kind === "gate") return "border-warning/35 bg-card hover:border-warning/60";
  if (kind === "end") return "border-success/35 bg-card hover:border-success/60";
  return "border-border bg-card hover:border-primary/45";
}

export function LunaFlowCanvas({
  spec,
  editable,
  selectedNodeId,
  selectedEdgeId,
  liveOverlay,
  onSelectNode,
  onSelectEdge,
  onAddNode,
  onAddEdge,
}: {
  readonly spec: FlowSpec;
  readonly editable: boolean;
  readonly selectedNodeId: string | null;
  readonly selectedEdgeId: string | null;
  readonly liveOverlay?: LiveFlowOverlay | null;
  readonly onSelectNode: (nodeId: string | null) => void;
  readonly onSelectEdge: (edgeId: string | null) => void;
  readonly onAddNode?: (kind: FlowNode["kind"]) => void;
  readonly onAddEdge?: (from: string, to: string) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [compactList, setCompactList] = useState(false);

  const layout = computeFlowLayout(spec);

  const handleNodeClick = (nodeId: string) => {
    if (editable && connectFrom !== null && onAddEdge) {
      if (connectFrom !== nodeId) {
        onAddEdge(connectFrom, nodeId);
      }
      setConnectFrom(null);
      return;
    }
    onSelectEdge(null);
    onSelectNode(nodeId);
  };

  const handleTriggerClick = () => {
    if (editable && connectFrom === "__pick__") {
      setConnectFrom("trigger");
      return;
    }
    onSelectNode(null);
    onSelectEdge(null);
  };

  const toggleConnectMode = () => {
    setConnectFrom((prev) => (prev === null ? "__pick__" : null));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
      {/* Canvas Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-card/70 px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {editable && onAddNode ? (
            <>
              <Button size="xs" variant="outline" onClick={() => onAddNode("agent")}>
                <BotIcon />
                <span>+ Agent</span>
              </Button>
              <Button size="xs" variant="outline" onClick={() => onAddNode("gate")}>
                <ShieldCheckIcon />
                <span>+ 审批门</span>
              </Button>
              <Button size="xs" variant="outline" onClick={() => onAddNode("script")}>
                <TerminalIcon />
                <span>+ 脚本</span>
              </Button>
              <Button size="xs" variant="outline" onClick={() => onAddNode("end")}>
                <FlagIcon />
                <span>+ 结束</span>
              </Button>
              <span aria-hidden className="mx-1 hidden h-4 w-px bg-border sm:inline-block" />
              <Button
                size="xs"
                variant={connectFrom !== null ? "default" : "outline"}
                onClick={toggleConnectMode}
              >
                <Link2Icon />
                <span>
                  {connectFrom === null
                    ? "连线"
                    : connectFrom === "__pick__"
                      ? "点选起点"
                      : `终点 (${connectFrom})`}
                </span>
              </Button>
            </>
          ) : (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <GitBranchIcon className="size-3.5" />
              <span>
                共 {layout.layers.length} 个阶段 · {spec.nodes.length} 个节点 · {spec.edges.length}{" "}
                条连线
              </span>
              {liveOverlay && liveOverlay.totalLoopHops > 0 ? (
                <Badge size="sm" variant="warning">
                  回流 {liveOverlay.totalLoopHops} 轮
                </Badge>
              ) : null}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1">
          <Button
            size="xs"
            variant={compactList ? "secondary" : "ghost"}
            onClick={() => setCompactList(!compactList)}
          >
            <LayersIcon />
            <span>{compactList ? "DAG 画布" : "阶段视图"}</span>
          </Button>
          {!compactList ? (
            <>
              <Button
                size="xs"
                variant="ghost"
                aria-label="缩小画布"
                onClick={() => setZoom((z) => Math.max(0.65, Number((z - 0.1).toFixed(2))))}
              >
                <ZoomOutIcon />
              </Button>
              <button
                type="button"
                className="cursor-pointer rounded px-1.5 py-0.5 font-mono text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => setZoom(1)}
              >
                {Math.round(zoom * 100)}%
              </button>
              <Button
                size="xs"
                variant="ghost"
                aria-label="放大画布"
                onClick={() => setZoom((z) => Math.min(1.4, Number((z + 0.1).toFixed(2))))}
              >
                <ZoomInIcon />
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {/* Stage List Mode (ideal for narrow viewports or quick topological scanning) */}
      {compactList ? (
        <div className="scrollbar-gutter-both min-h-0 flex-1 space-y-4 overflow-auto p-4">
          {layout.layers.map((layer) => (
            <div
              key={layer.index}
              className="space-y-2 rounded-lg border border-border bg-card/40 p-3"
            >
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-foreground">阶段 {layer.index + 1}</span>
                <Badge size="sm" variant={layer.parallel ? "info" : "outline"}>
                  {layer.parallel ? `并行 ${layer.nodeIds.length}` : "串行"}
                </Badge>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {layer.nodeIds.map((nodeId) => {
                  const positioned = layout.nodeById[nodeId];
                  if (!positioned) return null;
                  const { node } = positioned;
                  const live = liveOverlay?.nodeStates[node.id];
                  const selected = selectedNodeId === node.id;
                  return (
                    <button
                      key={node.id}
                      type="button"
                      className={cn(
                        "flex w-full cursor-pointer flex-col gap-1 rounded-lg border p-2.5 text-left transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        cardSurfaceClass(
                          node.kind,
                          selected,
                          connectFrom === node.id,
                          live?.status,
                        ),
                      )}
                      onClick={() => {
                        if (editable && connectFrom === "__pick__") {
                          setConnectFrom(node.id);
                        } else {
                          handleNodeClick(node.id);
                        }
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
                          <NodeKindIcon kind={node.kind} />
                          <span className="truncate">{node.label}</span>
                        </span>
                        {live ? (
                          <Badge size="sm" variant={STATUS_BADGE_MAP[live.status].variant}>
                            {STATUS_BADGE_MAP[live.status].label}
                            {live.visitCount > 1 ? ` #${live.visitCount}` : ""}
                          </Badge>
                        ) : (
                          <span className="shrink-0 font-mono text-xs text-muted-foreground">
                            {nodeKindTag(node.kind)}
                          </span>
                        )}
                      </div>
                      <span className="truncate text-xs text-muted-foreground">
                        {nodeSubLabel(spec, node)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* Layered DAG Canvas */
        <div
          className="relative min-h-80 flex-1 overflow-auto bg-muted/15"
          style={{
            backgroundImage:
              "radial-gradient(color-mix(in oklab, var(--color-border) 60%, transparent) 1px, transparent 1px)",
            backgroundSize: "18px 18px",
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              if (connectFrom !== null) setConnectFrom(null);
              else {
                onSelectNode(null);
                onSelectEdge(null);
              }
            }
          }}
        >
          <div
            className="relative origin-top-left"
            style={{
              width: layout.width * zoom,
              height: layout.height * zoom,
            }}
          >
            <div
              className="relative origin-top-left"
              style={{
                width: layout.width,
                height: layout.height,
                transform: `scale(${zoom})`,
              }}
            >
              {/* SVG Edges */}
              <svg
                width={layout.width}
                height={layout.height}
                className="pointer-events-none absolute inset-0"
                aria-hidden
              >
                <defs>
                  <marker
                    id="luna-flow-arrow"
                    viewBox="0 0 10 10"
                    refX="8.5"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1.5 L 9 5 L 0 8.5 z" className="fill-muted-foreground" />
                  </marker>
                  <marker
                    id="luna-flow-arrow-active"
                    viewBox="0 0 10 10"
                    refX="8.5"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1.5 L 9 5 L 0 8.5 z" className="fill-primary" />
                  </marker>
                  <marker
                    id="luna-flow-arrow-loop"
                    viewBox="0 0 10 10"
                    refX="8.5"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1.5 L 9 5 L 0 8.5 z" className="fill-warning-foreground" />
                  </marker>
                </defs>

                {layout.edges.map(({ edge, d, isLoop }) => {
                  const selected = selectedEdgeId === edge.id;
                  return (
                    <g key={edge.id} className="pointer-events-auto cursor-pointer">
                      <path
                        d={d}
                        fill="none"
                        stroke="transparent"
                        strokeWidth={16}
                        onClick={() => {
                          onSelectNode(null);
                          onSelectEdge(edge.id);
                        }}
                      />
                      <path
                        d={d}
                        fill="none"
                        strokeDasharray={isLoop ? "5 4" : undefined}
                        strokeWidth={selected ? 2.4 : 1.6}
                        className={cn(
                          "transition-colors",
                          selected
                            ? "stroke-primary"
                            : isLoop
                              ? "stroke-warning-foreground/75"
                              : "stroke-muted-foreground/60",
                        )}
                        markerEnd={
                          selected
                            ? "url(#luna-flow-arrow-active)"
                            : isLoop
                              ? "url(#luna-flow-arrow-loop)"
                              : "url(#luna-flow-arrow)"
                        }
                        onClick={() => {
                          onSelectNode(null);
                          onSelectEdge(edge.id);
                        }}
                      />
                    </g>
                  );
                })}
              </svg>

              {/* Trigger Anchor */}
              <button
                type="button"
                className={cn(
                  "absolute flex cursor-pointer items-center justify-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  connectFrom === "trigger"
                    ? "border-warning bg-warning/15 text-warning-foreground"
                    : "border-primary/40 bg-card text-foreground hover:border-primary",
                )}
                style={{
                  left: layout.triggerAnchor.x,
                  top: layout.triggerAnchor.y,
                  width: layout.triggerAnchor.width,
                  height: layout.triggerAnchor.height,
                }}
                onClick={handleTriggerClick}
              >
                <PlayIcon className="size-3 text-primary" />
                <span>触发器</span>
              </button>

              {/* Flow Node Cards */}
              {layout.nodes.map(({ node, x, y, width, height }) => {
                const live = liveOverlay?.nodeStates[node.id];
                const selected = selectedNodeId === node.id;
                const isSource = connectFrom === node.id;
                const statusInfo = live ? STATUS_BADGE_MAP[live.status] : null;
                const canConnectThis =
                  editable && connectFrom !== null && connectFrom !== "__pick__";
                return (
                  <div
                    key={node.id}
                    className="absolute"
                    style={{ left: x, top: y, width, height }}
                  >
                    <button
                      type="button"
                      data-flow-node={node.id}
                      className={cn(
                        "flex size-full cursor-pointer flex-col justify-between rounded-xl border p-2.5 text-left transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        cardSurfaceClass(node.kind, selected, isSource, live?.status),
                      )}
                      onClick={() => {
                        if (editable && connectFrom === "__pick__") {
                          setConnectFrom(node.id);
                        } else {
                          handleNodeClick(node.id);
                        }
                      }}
                    >
                      <div className="flex w-full items-center justify-between gap-1.5">
                        <span className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-foreground">
                          <NodeKindIcon kind={node.kind} />
                          <span className="truncate">{node.label}</span>
                        </span>
                        {statusInfo ? (
                          <Badge size="sm" variant={statusInfo.variant}>
                            {statusInfo.label}
                            {live && live.visitCount > 1 ? ` #${live.visitCount}` : ""}
                          </Badge>
                        ) : (
                          <span className="shrink-0 font-mono text-xs text-muted-foreground">
                            {nodeKindTag(node.kind)}
                          </span>
                        )}
                      </div>

                      <div className="flex w-full items-center justify-between gap-1.5 text-xs text-muted-foreground">
                        <span className="truncate">{nodeSubLabel(spec, node)}</span>
                        <span className="shrink-0 font-mono opacity-75">
                          {canConnectThis && connectFrom !== node.id ? "点此连入" : node.id}
                        </span>
                      </div>
                    </button>
                  </div>
                );
              })}

              {/* Edge Condition Labels (rendered above cards with opaque backdrop) */}
              {layout.edges.map(({ edge, labelX, labelY, isLoop }) => {
                const text = edge.when?.trim()
                  ? edge.when.length > 18
                    ? `${edge.when.slice(0, 17)}…`
                    : edge.when
                  : isLoop
                    ? "回流"
                    : null;
                if (!text && !editable) return null;
                const selected = selectedEdgeId === edge.id;
                return (
                  <button
                    key={`label:${edge.id}`}
                    type="button"
                    className={cn(
                      "absolute -translate-x-1/2 -translate-y-1/2 cursor-pointer whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-xs transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      selected
                        ? "border-primary bg-primary text-primary-foreground shadow-xs"
                        : isLoop
                          ? "border-warning/60 bg-card text-warning-foreground shadow-xs hover:border-warning"
                          : "border-border bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground",
                    )}
                    style={{ left: labelX, top: labelY }}
                    onClick={() => {
                      onSelectNode(null);
                      onSelectEdge(edge.id);
                    }}
                  >
                    {text ?? "条件"}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
