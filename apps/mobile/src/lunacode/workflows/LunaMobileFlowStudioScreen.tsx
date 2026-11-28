import { useAtomValue } from "@effect/atom-react";
import {
  computeFlowDryRunClient,
  formatFlowSpecJson,
  nextFlowVersionTarget,
  parseFlowSpecSafe,
  validateFlowClient,
} from "@t3tools/client-runtime/lunacode/workflow-flow";
import { EnvironmentId, type FlowBotRole, type FlowNode, type FlowSpec } from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { Card, reportFailure } from "../../features/workflows/WorkflowStepCard";
import { environmentProjects } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { LunaMobileFlowGraph } from "./LunaMobileFlowGraph";

export type LunaFlowStudioParams = {
  readonly environmentId: string;
  readonly fileName: string;
};

type MobileStudioTab = "graph" | "roles" | "settings" | "json";

function MobileStudioBody({
  environmentId,
  fileName,
  initialSource,
}: {
  readonly environmentId: EnvironmentId;
  readonly fileName: string;
  readonly initialSource: string;
}) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const canSave = useAtomValue(
    serverEnvironment.saveWorkflowDefinition.permissionAtom(environmentId),
  );
  const canStart = useAtomValue(serverEnvironment.startWorkflowRun.permissionAtom(environmentId));
  const projects = useAtomValue(environmentProjects.projectsAtom).filter(
    (p) => p.environmentId === environmentId,
  );
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? [];

  const saveDef = useAtomCommand(serverEnvironment.saveWorkflowDefinition, {
    label: "mobile studio save",
    reportFailure: false,
  });
  const startRun = useAtomCommand(serverEnvironment.startWorkflowRun, {
    label: "mobile studio start",
    reportFailure: false,
  });

  const [tab, setTab] = useState<MobileStudioTab>(() =>
    parseFlowSpecSafe(initialSource).ok ? "graph" : "json",
  );
  const [text, setText] = useState(initialSource);
  const [draftSpec, setDraftSpec] = useState<FlowSpec | null>(() => {
    const p = parseFlowSpecSafe(initialSource);
    return p.ok ? p.spec : null;
  });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  const parsed = parseFlowSpecSafe(text);
  const spec = tab === "json" ? (parsed.ok ? parsed.spec : null) : draftSpec;
  const issues = spec ? validateFlowClient(spec) : [];
  const dryRun = spec ? computeFlowDryRunClient(spec) : null;
  const errCount = issues.filter((i) => i.severity === "error").length;

  const commitSpec = (next: FlowSpec) => {
    setDraftSpec(next);
    setText(formatFlowSpecJson(next));
  };

  const addNode = (kind: FlowNode["kind"]) => {
    if (!spec) return;
    let idx = spec.nodes.length + 1;
    let id = `${kind}_${idx}`;
    const existing = new Set(spec.nodes.map((n) => n.id));
    while (existing.has(id)) {
      idx += 1;
      id = `${kind}_${idx}`;
    }
    const botId = Object.keys(spec.bots)[0] ?? "worker";
    const project = projects[0]?.id ?? "default-project";
    const created: FlowNode =
      kind === "agent"
        ? {
            id,
            kind: "agent",
            label: `Agent ${idx}`,
            botId,
            project,
            promptTemplate: "{{payload.task}}",
          }
        : kind === "gate"
          ? {
              id,
              kind: "gate",
              label: `审批门 ${idx}`,
              gateMode: "human",
              titleTemplate: "请确认是否继续？",
              choices: [{ value: "批准" }, { value: "拒绝", requireReason: true }],
            }
          : kind === "script"
            ? { id, kind: "script", label: `脚本 ${idx}`, command: ["git", "status"], cwd: "." }
            : { id, kind: "end", label: `结束 ${idx}`, outcome: "complete" };

    const fromId = selectedNodeId ?? (spec.nodes.length === 0 ? "trigger" : null);
    commitSpec({
      ...spec,
      nodes: [...spec.nodes, created],
      edges:
        fromId !== null
          ? [...spec.edges, { id: `e_${spec.edges.length + 1}`, from: fromId, to: id }]
          : spec.edges,
    });
    setSelectedNodeId(id);
  };

  const saveTarget = async (targetFile: string, content: string, replaceScreen = false) => {
    if (saving || !canSave) return false;
    setSaving(true);
    const res = await saveDef({ environmentId, input: { name: targetFile, source: content } });
    setSaving(false);
    if (res._tag === "Failure") {
      reportFailure("保存失败", res);
      return false;
    }
    if (replaceScreen) {
      navigation.dispatch(
        StackActions.replace("LunaFlowStudio", { environmentId, fileName: targetFile }),
      );
    }
    return res.value.changed;
  };

  const handleSave = async () => {
    if (!spec) {
      reportFailure("JSON 无法解析", { _tag: "Failure", cause: {} as never } as never);
      return;
    }
    await saveTarget(fileName, formatFlowSpecJson(spec));
  };

  const handleNextVersion = async () => {
    if (!spec || errCount > 0) return;
    const target = nextFlowVersionTarget(fileName, spec);
    await saveTarget(target.fileName, formatFlowSpecJson(target.spec), true);
  };

  const handleRun = async () => {
    if (!spec || errCount > 0 || running || !canStart) return;
    setRunning(true);
    await saveDef({ environmentId, input: { name: fileName, source: formatFlowSpecJson(spec) } });
    const res = await startRun({ environmentId, input: { workflow: spec.name } });
    setRunning(false);
    if (res._tag === "Failure") {
      reportFailure("启动失败", res);
      return;
    }
    navigation.navigate("WorkflowRun", { environmentId, runId: res.value.runId });
  };

  const selectedNode =
    spec && selectedNodeId ? (spec.nodes.find((n) => n.id === selectedNodeId) ?? null) : null;

  return (
    <ScreenScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      contentContainerClassName="gap-4 px-5 pt-3"
      contentContainerStyle={{ paddingBottom: insets.bottom + 36 }}
    >
      <SegmentedControl
        options={[
          { value: "graph", label: "流程图" },
          { value: "roles", label: "Bot 角色" },
          { value: "settings", label: "设置" },
          { value: "json", label: "JSON" },
        ]}
        selected={tab}
        onSelect={setTab}
        role="tab"
      />

      {spec && tab === "graph" ? (
        <View className="gap-3">
          <View className="flex-row flex-wrap gap-2">
            <Chip label="+ Agent" size="small" onPress={() => addNode("agent")} />
            <Chip label="+ 审批门" size="small" onPress={() => addNode("gate")} />
            <Chip label="+ 脚本" size="small" onPress={() => addNode("script")} />
            <Chip label="+ 结束" size="small" onPress={() => addNode("end")} />
          </View>

          <LunaMobileFlowGraph
            spec={spec}
            editable
            selectedNodeId={selectedNodeId}
            onSelectNode={(id) => setSelectedNodeId(id)}
          />

          {selectedNode ? (
            <Card>
              <View className="flex-row items-center justify-between">
                <Text className="font-t3-medium text-sm text-foreground">
                  编辑节点 · {selectedNode.id}
                </Text>
                <Button
                  size="compact"
                  tone="danger"
                  label="删除"
                  onPress={() => {
                    commitSpec({
                      ...spec,
                      nodes: spec.nodes.filter((n) => n.id !== selectedNode.id),
                      edges: spec.edges.filter(
                        (e) => e.from !== selectedNode.id && e.to !== selectedNode.id,
                      ),
                    });
                    setSelectedNodeId(null);
                  }}
                />
              </View>
              <TextInput
                value={selectedNode.label}
                onChangeText={(label) =>
                  commitSpec({
                    ...spec,
                    nodes: spec.nodes.map((n) => (n.id === selectedNode.id ? { ...n, label } : n)),
                  })
                }
                placeholder="节点显示名称"
              />
              {selectedNode.kind === "agent" ? (
                <>
                  <View className="flex-row flex-wrap gap-2">
                    {Object.keys(spec.bots).map((botId) => (
                      <Chip
                        key={botId}
                        size="small"
                        label={spec.bots[botId]?.label ?? botId}
                        selected={selectedNode.botId === botId}
                        onPress={() =>
                          commitSpec({
                            ...spec,
                            nodes: spec.nodes.map((n) =>
                              n.id === selectedNode.id && n.kind === "agent" ? { ...n, botId } : n,
                            ),
                          })
                        }
                      />
                    ))}
                  </View>
                  <View className="flex-row flex-wrap gap-2">
                    {(["worktree", "root"] as const).map((ws) => (
                      <Chip
                        key={ws}
                        size="small"
                        label={`工作区: ${ws}`}
                        selected={
                          (selectedNode.workspaceOverride ??
                            spec.bots[selectedNode.botId]?.workspace) === ws
                        }
                        onPress={() =>
                          commitSpec({
                            ...spec,
                            nodes: spec.nodes.map((n) =>
                              n.id === selectedNode.id && n.kind === "agent"
                                ? { ...n, workspaceOverride: ws }
                                : n,
                            ),
                          })
                        }
                      />
                    ))}
                  </View>
                  <TextInput
                    multiline
                    value={selectedNode.promptTemplate}
                    onChangeText={(promptTemplate) =>
                      commitSpec({
                        ...spec,
                        nodes: spec.nodes.map((n) =>
                          n.id === selectedNode.id && n.kind === "agent"
                            ? { ...n, promptTemplate }
                            : n,
                        ),
                      })
                    }
                    placeholder="Agent Prompt 模板"
                  />
                </>
              ) : selectedNode.kind === "gate" ? (
                <TextInput
                  multiline
                  value={selectedNode.titleTemplate}
                  onChangeText={(titleTemplate) =>
                    commitSpec({
                      ...spec,
                      nodes: spec.nodes.map((n) =>
                        n.id === selectedNode.id && n.kind === "gate" ? { ...n, titleTemplate } : n,
                      ),
                    })
                  }
                  placeholder="人工审批提示语"
                />
              ) : null}
            </Card>
          ) : null}

          {dryRun ? (
            <Card tone={dryRun.valid ? undefined : "failed"}>
              <Text className="font-t3-medium text-xs text-foreground">
                预演结果：{dryRun.valid ? "通过" : `${errCount} 个阻断错误`} ·{" "}
                {dryRun.layers.length} 阶段 · 上限 {dryRun.maxHops} 轮回流
              </Text>
              {issues.map((issue) => (
                <Text
                  key={`${issue.code}:${issue.nodeId ?? issue.message}`}
                  className={
                    issue.severity === "error"
                      ? "text-xs text-danger-foreground"
                      : "text-xs text-warning-foreground"
                  }
                >
                  {issue.message}
                </Text>
              ))}
            </Card>
          ) : null}
        </View>
      ) : spec && tab === "roles" ? (
        <View className="gap-3">
          {Object.entries(spec.bots).map(([botId, role]) => (
            <Card key={botId}>
              <Text className="font-t3-medium text-sm text-foreground">
                {botId} ({role.label})
              </Text>
              <TextInput
                value={role.label}
                onChangeText={(label) =>
                  commitSpec({
                    ...spec,
                    bots: { ...spec.bots, [botId]: { ...role, label } },
                  })
                }
                placeholder="Bot 显示名"
              />
              <View className="flex-row flex-wrap gap-2">
                {(["worktree", "root"] as const).map((ws) => (
                  <Chip
                    key={ws}
                    size="small"
                    label={ws}
                    selected={(role.workspace ?? "root") === ws}
                    onPress={() =>
                      commitSpec({
                        ...spec,
                        bots: { ...spec.bots, [botId]: { ...role, workspace: ws } },
                      })
                    }
                  />
                ))}
                {providers.slice(0, 4).map((p) => (
                  <Chip
                    key={p.instanceId}
                    size="small"
                    label={p.displayName ?? p.driver}
                    selected={role.providerInstanceId === p.instanceId}
                    onPress={() => {
                      const m = p.models.find((item) => item.isDefault) ?? p.models[0];
                      const nextRole: FlowBotRole = {
                        ...role,
                        providerInstanceId: p.instanceId,
                        ...(m ? { model: m.slug } : {}),
                      };
                      commitSpec({ ...spec, bots: { ...spec.bots, [botId]: nextRole } });
                    }}
                  />
                ))}
              </View>
              <TextInput
                multiline
                value={role.rolePrompt ?? ""}
                onChangeText={(rolePrompt) =>
                  commitSpec({
                    ...spec,
                    bots: {
                      ...spec.bots,
                      [botId]: {
                        ...role,
                        ...(rolePrompt ? { rolePrompt } : { rolePrompt: undefined }),
                      },
                    },
                  })
                }
                placeholder="Bot 职责说明 Prompt"
              />
            </Card>
          ))}
        </View>
      ) : spec && tab === "settings" ? (
        <Card>
          <Text className="font-t3-medium text-sm text-foreground">名称与回流上限</Text>
          <TextInput
            value={spec.name}
            onChangeText={(name) => commitSpec({ ...spec, name: name.trim() || spec.name })}
            placeholder="工作流唯一 ID"
          />
          <TextInput
            multiline
            value={spec.description ?? ""}
            onChangeText={(description) =>
              commitSpec({
                ...spec,
                ...(description ? { description } : { description: undefined }),
              })
            }
            placeholder="描述说明"
          />
          <Text className="text-xs text-foreground-muted">
            当前回流上限 maxHops = {spec.maxHops ?? 2}
          </Text>
        </Card>
      ) : (
        <View className="gap-2">
          {!parsed.ok ? (
            <Text className="text-xs text-danger-foreground">{parsed.error}</Text>
          ) : null}
          <TextInput
            multiline
            value={text}
            onChangeText={(val) => {
              setText(val);
              const nextParsed = parseFlowSpecSafe(val);
              if (nextParsed.ok) setDraftSpec(nextParsed.spec);
            }}
            className="min-h-64 font-mono text-xs"
          />
        </View>
      )}

      {/* Actions Footer */}
      <View className="gap-2 pt-2">
        {canSave ? (
          <View className="flex-row gap-2">
            <Button
              tone="primary"
              size="compact"
              label="保存"
              loading={saving}
              onPress={() => void handleSave()}
            />
            {spec ? (
              <Button
                tone="secondary"
                size="compact"
                label={`创建 v${spec.version + 1}`}
                disabled={saving || errCount > 0}
                onPress={() => void handleNextVersion()}
              />
            ) : null}
          </View>
        ) : null}
        {spec && canStart ? (
          <Button
            tone="contrast"
            fullWidth
            label="保存并立即运行"
            disabled={errCount > 0}
            loading={running}
            onPress={() => void handleRun()}
          />
        ) : null}
      </View>
    </ScreenScrollView>
  );
}

export function LunaMobileFlowStudioScreen({ route }: StaticScreenProps<LunaFlowStudioParams>) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const defQuery = useEnvironmentQuery(
    serverEnvironment.workflowDefinition({ environmentId, input: {} }),
  );
  const file = defQuery.data?.files.find((f) => f.name === route.params.fileName) ?? null;

  return (
    <View className="flex-1 bg-screen">
      <AppBar
        title={route.params.fileName}
        onBack={() => {
          if (navigation.canGoBack()) navigation.goBack();
        }}
      />
      {defQuery.data === null ? (
        <EmptyState
          variant="plain"
          title={defQuery.error ?? "加载工作流中..."}
          detail="正在读取工作流定义"
        />
      ) : file === null ? (
        <EmptyState variant="plain" title="未找到工作流文件" detail={route.params.fileName} />
      ) : (
        <MobileStudioBody
          key={`${file.name}:${defQuery.data.revision}`}
          environmentId={environmentId}
          fileName={file.name}
          initialSource={file.source}
        />
      )}
    </View>
  );
}
