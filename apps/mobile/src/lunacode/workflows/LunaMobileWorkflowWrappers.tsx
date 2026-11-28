import {
  buildLiveRunGraphOverlay,
  isFlowDefinitionFile,
  parseFlowSpecSafe,
} from "@t3tools/client-runtime/lunacode/workflow-flow";
import type { WorkflowRunNode } from "@t3tools/client-runtime/workflows";
import type { EnvironmentId, FlowSpec, WorkflowStep } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useState, type ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { LunaMobileFlowGraph } from "./LunaMobileFlowGraph";
import { LunaMobileFlowsList } from "./LunaMobileFlowsList";
import { LunaMobileLiveCrewPanel } from "./LunaMobileLiveCrewPanel";

export function LunaMobileWorkflowsRootSwitch({
  environments,
  children,
}: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly children: ReactNode;
}) {
  const [section, setSection] = useState<"runs" | "flows">("runs");
  const navigation = useNavigation();

  return (
    <View className="flex-1">
      <View className="px-5 pt-2">
        <SegmentedControl
          size="compact"
          options={[
            { value: "runs", label: "运行记录" },
            { value: "flows", label: "可视化编排" },
          ]}
          selected={section}
          onSelect={setSection}
          role="tab"
        />
      </View>
      {section === "runs" ? (
        children
      ) : (
        <LunaMobileFlowsList
          environments={environments}
          onOpenStudio={(environmentId, fileName) =>
            navigation.navigate("LunaFlowStudio", { environmentId, fileName })
          }
          onOpenRun={(environmentId, runId) =>
            navigation.navigate("WorkflowRun", { environmentId, runId })
          }
        />
      )}
    </View>
  );
}

export function LunaMobileRunViewSwitch({
  environmentId,
  node,
  steps,
  canAnswer,
  onOpenThread,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly node: WorkflowRunNode;
  readonly steps: ReadonlyArray<WorkflowStep> | undefined;
  readonly canAnswer: boolean;
  readonly onOpenThread: (thread: { threadId: string; environmentId: string | null }) => void;
  readonly children: ReactNode;
}) {
  const [mode, setMode] = useState<"timeline" | "graph" | "crew">("timeline");
  const defQuery = useEnvironmentQuery(
    serverEnvironment.workflowDefinition({ environmentId, input: {} }),
  );

  const flowFiles = (defQuery.data?.files ?? []).filter((f) => isFlowDefinitionFile(f.name));
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

  return (
    <View className="gap-3">
      <SegmentedControl
        size="compact"
        options={[
          { value: "timeline", label: "时间线" },
          { value: "graph", label: "流程图" },
          { value: "crew", label: `Bot 协作 (${overlay.crew.length})` },
        ]}
        selected={mode}
        onSelect={setMode}
        role="tab"
      />

      {mode === "timeline" ? (
        children
      ) : mode === "graph" ? (
        displaySpec && displaySpec.nodes.length > 0 ? (
          <LunaMobileFlowGraph
            spec={displaySpec}
            liveOverlay={overlay}
            onSelectNode={(nodeId) => {
              const st = overlay.nodeStates[nodeId];
              if (st?.threadId) {
                onOpenThread({ threadId: st.threadId, environmentId: st.environmentId });
              }
            }}
          />
        ) : (
          <Text className="px-1 text-sm text-foreground-muted">暂无可展示的流程节点。</Text>
        )
      ) : (
        <LunaMobileLiveCrewPanel
          environmentId={environmentId}
          overlay={overlay}
          questions={node.questions}
          canAnswer={canAnswer}
          onOpenThread={onOpenThread}
        />
      )}
    </View>
  );
}
