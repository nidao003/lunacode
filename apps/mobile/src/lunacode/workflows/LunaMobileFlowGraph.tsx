import {
  computeFlowDryRunClient,
  type LiveFlowOverlay,
  type LiveNodeStatus,
} from "@t3tools/client-runtime/lunacode/workflow-flow";
import type { FlowNode, FlowSpec } from "@t3tools/contracts";
import { Pressable, View } from "react-native";
import Svg, { Path } from "react-native-svg";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";

const STATUS_STYLE: Record<
  LiveNodeStatus,
  { readonly label: string; readonly className: string; readonly textClassName: string }
> = {
  pending: {
    label: "待运行",
    className: "bg-subtle-strong",
    textClassName: "text-foreground-muted",
  },
  running: {
    label: "工作中",
    className: "bg-primary/15",
    textClassName: "text-primary",
  },
  waiting: {
    label: "待审批",
    className: "bg-warning/20",
    textClassName: "text-warning-foreground",
  },
  completed: {
    label: "已完成",
    className: "bg-primary/15",
    textClassName: "text-primary-text",
  },
  failed: {
    label: "失败",
    className: "bg-danger/15",
    textClassName: "text-danger-foreground",
  },
  skipped: {
    label: "已跳过",
    className: "bg-subtle-strong",
    textClassName: "text-foreground-muted",
  },
};

function kindLabel(kind: FlowNode["kind"]): string {
  if (kind === "agent") return "Agent";
  if (kind === "gate") return "审批门";
  if (kind === "script") return "脚本";
  return "结束";
}

function nodeSubTitle(spec: FlowSpec, node: FlowNode): string {
  if (node.kind === "agent") {
    const bot = spec.bots[node.botId];
    const ws = node.workspaceOverride ?? bot?.workspace ?? "root";
    return `${bot?.label ?? node.botId} · ${ws}`;
  }
  if (node.kind === "gate") {
    return node.gateMode === "coordinator_then_human" ? "协调者后人工拍板" : "人工确认";
  }
  if (node.kind === "script") {
    return node.command.slice(0, 3).join(" ");
  }
  return node.outcome;
}

export function LunaMobileFlowGraph({
  spec,
  editable,
  selectedNodeId,
  liveOverlay,
  onSelectNode,
}: {
  readonly spec: FlowSpec;
  readonly editable?: boolean;
  readonly selectedNodeId?: string | null;
  readonly liveOverlay?: LiveFlowOverlay | null;
  readonly onSelectNode?: (nodeId: string) => void;
}) {
  const dryRun = computeFlowDryRunClient(spec);
  const nodeMap = new Map(spec.nodes.map((n) => [n.id, n]));

  return (
    <View className="gap-3">
      {/* Stage Layers */}
      {dryRun.layers.map((layer, stagePos) => (
        <View key={`stage-${layer.index}`} className="gap-2">
          <View className="rounded-2xl border border-border-subtle bg-card/60 p-3 gap-2">
            <View className="flex-row items-center justify-between">
              <Text className="font-t3-medium text-xs text-foreground-muted">
                阶段 {layer.index + 1}
              </Text>
              <View
                className={cn(
                  "rounded-full px-2 py-0.5",
                  layer.parallel ? "bg-primary/15" : "bg-subtle",
                )}
              >
                <Text
                  className={cn(
                    "font-t3-medium text-xs",
                    layer.parallel ? "text-primary" : "text-foreground-muted",
                  )}
                >
                  {layer.parallel ? `并行 ${layer.nodeIds.length}` : "串行"}
                </Text>
              </View>
            </View>

            <View className="gap-2">
              {layer.nodeIds.map((nodeId) => {
                const node = nodeMap.get(nodeId);
                if (!node) return null;
                const live = liveOverlay?.nodeStates[node.id];
                const selected = selectedNodeId === node.id;
                const st = live ? STATUS_STYLE[live.status] : null;
                const interactive = Boolean(editable || live?.threadId || onSelectNode);

                return (
                  <Pressable
                    key={node.id}
                    accessibilityRole={interactive ? "button" : undefined}
                    onPress={() => onSelectNode?.(node.id)}
                    className={cn(
                      "gap-1.5 rounded-xl border p-3 active:opacity-80",
                      selected
                        ? "border-primary bg-primary/10"
                        : live?.status === "waiting"
                          ? "border-warning-border bg-warning"
                          : live?.status === "failed"
                            ? "border-danger-border bg-danger/5"
                            : "border-border bg-card",
                    )}
                  >
                    <View className="flex-row items-center justify-between gap-2">
                      <Text
                        numberOfLines={1}
                        className="min-w-0 flex-1 font-t3-medium text-sm text-foreground"
                      >
                        {node.label}
                      </Text>
                      {st ? (
                        <View className={cn("rounded-full px-2 py-0.5", st.className)}>
                          <Text className={cn("font-t3-medium text-xs", st.textClassName)}>
                            {st.label}
                            {live && live.visitCount > 1 ? ` #${live.visitCount}` : ""}
                          </Text>
                        </View>
                      ) : (
                        <View className="rounded-full bg-subtle px-2 py-0.5">
                          <Text className="text-xs text-foreground-muted">
                            {kindLabel(node.kind)}
                          </Text>
                        </View>
                      )}
                    </View>

                    <View className="flex-row items-center justify-between gap-2">
                      <Text
                        numberOfLines={1}
                        className="min-w-0 flex-1 text-xs text-foreground-muted"
                      >
                        {nodeSubTitle(spec, node)}
                      </Text>
                      <Text className="text-xs text-foreground-muted">{node.id}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {stagePos < dryRun.layers.length - 1 ? (
            <View className="items-center py-0.5">
              <Svg width={20} height={18} viewBox="0 0 20 18">
                <Path
                  d="M 10 1 L 10 14 M 5 10 L 10 15 L 15 10"
                  stroke="#888888"
                  strokeWidth={1.75}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </Svg>
            </View>
          ) : null}
        </View>
      ))}

      {/* Bounded Loop-Back Edges Summary */}
      {dryRun.loopEdges.length > 0 ? (
        <View className="gap-1.5 rounded-2xl border border-warning-border bg-warning/10 p-3">
          <Text className="font-t3-medium text-xs text-warning-foreground">
            有界回流规则（最大熔断 {dryRun.maxHops} 轮）
          </Text>
          {dryRun.loopEdges.map((loop) => (
            <Text key={loop.edgeId} className="text-xs text-foreground">
              {loop.from} → {loop.to}
              {loop.when ? `  [${loop.when}]` : ""}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}
