import { useAtomValue } from "@effect/atom-react";
import {
  createStarterFlowSpec,
  type FlowStarterTemplateId,
  formatFlowSpecJson,
  isFlowDefinitionFile,
  normalizeFlowFileName,
  parseFlowSpecSafe,
  validateFlowClient,
} from "@t3tools/client-runtime/lunacode/workflow-flow";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { Card, reportFailure } from "../../features/workflows/WorkflowStepCard";
import { environmentProjects } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

function EnvironmentFlowList({
  environmentId,
  environmentLabel,
  onOpenStudio,
  onOpenRun,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
  readonly onOpenStudio: (environmentId: EnvironmentId, fileName: string) => void;
  readonly onOpenRun: (environmentId: EnvironmentId, runId: string) => void;
}) {
  const defQuery = useEnvironmentQuery(
    serverEnvironment.workflowDefinition({ environmentId, input: {} }),
  );
  const canSave = useAtomValue(
    serverEnvironment.saveWorkflowDefinition.permissionAtom(environmentId),
  );
  const canStart = useAtomValue(serverEnvironment.startWorkflowRun.permissionAtom(environmentId));
  const allProjects = useAtomValue(environmentProjects.projectsAtom);
  const envProjects = allProjects.filter((p) => p.environmentId === environmentId);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? [];

  const saveDef = useAtomCommand(serverEnvironment.saveWorkflowDefinition, {
    label: "mobile new flow",
    reportFailure: false,
  });
  const startRun = useAtomCommand(serverEnvironment.startWorkflowRun, {
    label: "mobile start flow",
    reportFailure: false,
  });

  const [newName, setNewName] = useState("team-review");
  const [template, setTemplate] = useState<FlowStarterTemplateId>("parallel-review");
  const [creating, setCreating] = useState(false);
  const [startingFile, setStartingFile] = useState<string | null>(null);

  const flowFiles = (defQuery.data?.files ?? []).filter((f) => isFlowDefinitionFile(f.name));

  const createNew = async () => {
    if (creating || !canSave) return;
    setCreating(true);
    const fileName = normalizeFlowFileName(newName, "team-review");
    const defaultProvider = providers.find((p) => p.enabled && p.models.length > 0);
    const defaultModel =
      defaultProvider?.models.find((m) => m.isDefault) ?? defaultProvider?.models[0];
    const spec = createStarterFlowSpec({
      name: fileName.replace(/\.flow\.json$/i, ""),
      template,
      ...(envProjects[0]?.id ? { project: envProjects[0].id } : {}),
      ...(defaultProvider?.instanceId ? { providerInstanceId: defaultProvider.instanceId } : {}),
      ...(defaultModel?.slug ? { model: defaultModel.slug } : {}),
    });
    const res = await saveDef({
      environmentId,
      input: { name: fileName, source: formatFlowSpecJson(spec) },
    });
    setCreating(false);
    if (res._tag === "Failure") {
      reportFailure("创建工作流失败", res);
      return;
    }
    onOpenStudio(environmentId, fileName);
  };

  const launch = async (workflowName: string, fileName: string) => {
    if (startingFile !== null || !canStart) return;
    setStartingFile(fileName);
    const res = await startRun({
      environmentId,
      input: { workflow: workflowName },
    });
    setStartingFile(null);
    if (res._tag === "Failure") {
      reportFailure("启动工作流失败", res);
      return;
    }
    onOpenRun(environmentId, res.value.runId);
  };

  return (
    <View className="gap-3 px-5 pt-2">
      {environmentLabel ? (
        <Text className="font-t3-medium text-xs text-foreground-muted">{environmentLabel}</Text>
      ) : null}

      {/* Create Visual Flow Card */}
      {canSave ? (
        <Card>
          <Text className="font-t3-medium text-sm text-foreground">新建可视化工作流</Text>
          <TextInput
            value={newName}
            onChangeText={setNewName}
            placeholder="文件名（如 team-review）"
          />
          <View className="flex-row flex-wrap gap-2">
            <Chip
              label="并行评审流"
              size="small"
              selected={template === "parallel-review"}
              onPress={() => setTemplate("parallel-review")}
            />
            <Chip
              label="人工审批流"
              size="small"
              selected={template === "human-gate"}
              onPress={() => setTemplate("human-gate")}
            />
            <Chip
              label="单 Bot 任务"
              size="small"
              selected={template === "single-agent"}
              onPress={() => setTemplate("single-agent")}
            />
          </View>
          <Button
            tone="primary"
            size="compact"
            label="创建并编排"
            loading={creating}
            onPress={() => void createNew()}
          />
        </Card>
      ) : null}

      {defQuery.error ? (
        <Text className="text-sm text-danger-foreground">{defQuery.error}</Text>
      ) : flowFiles.length === 0 ? (
        <Card>
          <Text className="text-sm text-foreground-muted">
            暂无 `.flow.json` 可视化工作流，点击上方按钮即可创建。
          </Text>
        </Card>
      ) : (
        flowFiles.map((file) => {
          const parsed = parseFlowSpecSafe(file.source);
          const issues = parsed.ok ? validateFlowClient(parsed.spec) : [];
          const errCount = issues.filter((i) => i.severity === "error").length;

          return (
            <Card key={file.name}>
              <View className="flex-row items-center justify-between gap-2">
                <Text
                  numberOfLines={1}
                  className="min-w-0 flex-1 font-t3-medium text-base text-foreground"
                >
                  {parsed.ok ? parsed.spec.name : file.name}
                </Text>
                <Text
                  className={
                    errCount > 0 || !parsed.ok
                      ? "font-t3-medium text-xs text-danger-foreground"
                      : "font-t3-medium text-xs text-primary"
                  }
                >
                  {parsed.ok
                    ? errCount > 0
                      ? `${errCount} 错误`
                      : `v${parsed.spec.version}`
                    : "解析失败"}
                </Text>
              </View>
              <Text className="text-xs text-foreground-muted">
                {file.name}
                {parsed.ok
                  ? ` · ${Object.keys(parsed.spec.bots).length} Bots · ${parsed.spec.nodes.length} 节点`
                  : ""}
              </Text>
              <View className="flex-row flex-wrap gap-2 pt-1">
                <Button
                  size="compact"
                  tone="secondary"
                  label="可视化编辑"
                  onPress={() => onOpenStudio(environmentId, file.name)}
                />
                {parsed.ok && errCount === 0 && canStart ? (
                  <Button
                    size="compact"
                    tone="primary"
                    label="立即运行"
                    loading={startingFile === file.name}
                    onPress={() => void launch(parsed.spec.name, file.name)}
                  />
                ) : null}
              </View>
            </Card>
          );
        })
      )}
    </View>
  );
}

export function LunaMobileFlowsList({
  environments,
  onOpenStudio,
  onOpenRun,
}: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly onOpenStudio: (environmentId: EnvironmentId, fileName: string) => void;
  readonly onOpenRun: (environmentId: EnvironmentId, runId: string) => void;
}) {
  if (environments.length === 0) {
    return (
      <EmptyState
        variant="plain"
        title="未连接环境"
        detail="连接服务器后即可在手机上浏览、编排并运行多 Bot 工作流。"
      />
    );
  }

  return (
    <View className="gap-4">
      {environments.map((env) => (
        <EnvironmentFlowList
          key={env.environmentId}
          environmentId={env.environmentId}
          environmentLabel={environments.length > 1 ? env.label : null}
          onOpenStudio={onOpenStudio}
          onOpenRun={onOpenRun}
        />
      ))}
    </View>
  );
}
