import type {
  LiveFlowOverlay,
  LiveNodeStatus,
} from "@t3tools/client-runtime/lunacode/workflow-flow";
import {
  readWorkflowQuestion,
  type WorkflowQuestionChoice,
} from "@t3tools/client-runtime/workflows";
import type { EnvironmentId, WorkflowQuestion } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Card, reportFailure } from "../../features/workflows/WorkflowStepCard";
import { cn } from "../../lib/cn";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const STATUS_BADGE: Record<LiveNodeStatus, { readonly label: string; readonly cls: string }> = {
  pending: { label: "待执行", cls: "text-foreground-muted" },
  running: { label: "工作中", cls: "text-primary" },
  waiting: { label: "等待审批", cls: "text-warning-foreground" },
  completed: { label: "已完成", cls: "text-primary-text" },
  failed: { label: "失败", cls: "text-danger-foreground" },
  skipped: { label: "已跳过", cls: "text-foreground-muted" },
};

function MobileApprovalCard({
  environmentId,
  question,
  canAnswer,
  onOpenThread,
}: {
  readonly environmentId: EnvironmentId;
  readonly question: WorkflowQuestion;
  readonly canAnswer: boolean;
  readonly onOpenThread:
    | ((thread: { threadId: string; environmentId: string | null }) => void)
    | null;
}) {
  const view = readWorkflowQuestion(question);
  const [reason, setReason] = useState("");
  const [busyChoice, setBusyChoice] = useState<string | null>(null);
  const answer = useAtomCommand(serverEnvironment.answerWorkflowQuestion, {
    label: "mobile crew inline answer",
    reportFailure: false,
  });

  const pick = async (choice: WorkflowQuestionChoice) => {
    if (busyChoice !== null || !canAnswer) return;
    if (choice.requireReason && reason.trim().length === 0) {
      reportFailure(`选择「${choice.value}」需要填写审批意见`, {
        _tag: "Failure",
        cause: {} as never,
      } as never);
      return;
    }
    setBusyChoice(choice.value);
    const res = await answer({
      environmentId,
      input: {
        runId: question.runId,
        name: question.name,
        choice: choice.value,
        ...(reason.trim().length > 0 ? { reason: reason.trim() } : {}),
      },
    });
    setBusyChoice(null);
    reportFailure("发送审批失败", res);
  };

  return (
    <Card tone="input">
      <View className="flex-row items-center justify-between gap-2">
        <Text className="font-t3-medium text-xs text-warning-foreground">
          Needs you · {question.name}
        </Text>
        {question.thread && onOpenThread ? (
          <Button
            size="compact"
            tone="text"
            label="看会话"
            onPress={() => onOpenThread(question.thread!)}
          />
        ) : null}
      </View>
      <Text className="font-t3-medium text-sm text-foreground">{view.title}</Text>
      <TextInput
        value={reason}
        onChangeText={setReason}
        placeholder="补充说明 / 驳回原因（可选）"
      />
      <View className="gap-2 pt-1">
        {view.choices.map((choice) => (
          <Button
            key={choice.value}
            label={choice.value}
            tone="primary"
            fullWidth
            disabled={!canAnswer || busyChoice !== null}
            loading={busyChoice === choice.value}
            onPress={() => void pick(choice)}
          />
        ))}
      </View>
    </Card>
  );
}

export function LunaMobileLiveCrewPanel({
  environmentId,
  overlay,
  questions,
  canAnswer,
  onOpenThread,
}: {
  readonly environmentId: EnvironmentId;
  readonly overlay: LiveFlowOverlay;
  readonly questions: ReadonlyArray<WorkflowQuestion>;
  readonly canAnswer: boolean;
  readonly onOpenThread:
    | ((thread: { threadId: string; environmentId: string | null }) => void)
    | null;
}) {
  const runningCount = overlay.crew.filter((m) => m.status === "running").length;
  const completedCount = overlay.crew.filter((m) => m.status === "completed").length;

  return (
    <View className="gap-3">
      <View className="flex-row flex-wrap items-center gap-2 rounded-2xl border border-border-subtle bg-card p-3">
        <Text className="font-t3-medium text-xs text-foreground">Bot 实时协作</Text>
        <Text className="text-xs text-primary">工作中 {runningCount}</Text>
        <Text className="text-xs text-foreground-muted">
          已完成 {completedCount}/{overlay.crew.length}
        </Text>
        {overlay.totalLoopHops > 0 ? (
          <Text className="text-xs text-warning-foreground">回流 {overlay.totalLoopHops} 轮</Text>
        ) : null}
      </View>

      {questions.map((question) => (
        <MobileApprovalCard
          key={`${question.name}:${question.askedAt}`}
          environmentId={environmentId}
          question={question}
          canAnswer={canAnswer}
          onOpenThread={onOpenThread}
        />
      ))}

      {overlay.crew.length === 0 ? (
        <Card>
          <Text className="text-sm text-foreground-muted">该运行暂无 Agent 节点记录。</Text>
        </Card>
      ) : (
        overlay.crew.map((member) => {
          const st = STATUS_BADGE[member.status];
          return (
            <Card key={member.nodeId}>
              <View className="flex-row items-center justify-between gap-2">
                <Text
                  numberOfLines={1}
                  className="min-w-0 flex-1 font-t3-medium text-base text-foreground"
                >
                  {member.botLabel}
                </Text>
                <Text className={cn("font-t3-medium text-xs", st.cls)}>
                  {st.label}
                  {member.visitCount > 1 ? ` #${member.visitCount}` : ""}
                </Text>
              </View>
              <Text className="text-xs text-foreground-muted">
                节点：{member.nodeLabel} · {member.workspace} · {member.runtimeMode}
              </Text>
              {member.modelLabel ? (
                <Text className="text-xs text-foreground-muted">{member.modelLabel}</Text>
              ) : null}
              {member.summary ? (
                <Text
                  numberOfLines={3}
                  className="rounded-xl bg-subtle p-2.5 text-xs text-foreground"
                >
                  {member.summary}
                </Text>
              ) : null}
              {member.threadId && onOpenThread ? (
                <Button
                  size="compact"
                  tone="secondary"
                  label="查看 / 介入 (Steer)"
                  onPress={() =>
                    onOpenThread({
                      threadId: member.threadId!,
                      environmentId: member.environmentId,
                    })
                  }
                />
              ) : null}
            </Card>
          );
        })
      )}
    </View>
  );
}
