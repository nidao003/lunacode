import { useAtomValue } from "@effect/atom-react";
import type {
  LiveFlowOverlay,
  LiveNodeStatus,
} from "@t3tools/client-runtime/lunacode/workflow-flow";
import {
  readWorkflowQuestion,
  type WorkflowQuestionChoice,
} from "@t3tools/client-runtime/workflows";
import { type EnvironmentId, type WorkflowQuestion } from "@t3tools/contracts";
import { BotIcon, GitForkIcon, MessageSquareIcon, ShieldCheckIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import type { WorkflowThreadTarget } from "../../components/workflows/WorkflowRunFeed";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const STATUS_BADGE: Record<
  LiveNodeStatus,
  { readonly label: string; readonly variant: "outline" | "info" | "warning" | "success" | "error" }
> = {
  pending: { label: "待执行", variant: "outline" },
  running: { label: "工作中", variant: "info" },
  waiting: { label: "等待你审批", variant: "warning" },
  completed: { label: "已完成", variant: "success" },
  failed: { label: "失败", variant: "error" },
  skipped: { label: "已跳过", variant: "outline" },
};

function InlineApprovalCard({
  environmentId,
  question,
  onOpenThread,
}: {
  readonly environmentId: EnvironmentId;
  readonly question: WorkflowQuestion;
  readonly onOpenThread: (thread: WorkflowThreadTarget) => void;
}) {
  const view = readWorkflowQuestion(question);
  const canAnswer = useAtomValue(
    serverEnvironment.answerWorkflowQuestion.permissionAtom(environmentId),
  );
  const answer = useAtomCommand(serverEnvironment.answerWorkflowQuestion, {
    label: "crew inline approval",
  });
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (choice: WorkflowQuestionChoice) => {
    if (busy || !canAnswer) return;
    if (choice.requireReason && reason.trim().length === 0) {
      setError(`选择「${choice.value}」需要填写简短理由。`);
      return;
    }
    setBusy(true);
    setError(null);
    const res = await answer({
      environmentId,
      input: {
        runId: question.runId,
        name: question.name,
        choice: choice.value,
        ...(reason.trim().length > 0 ? { reason: reason.trim() } : {}),
      },
    });
    setBusy(false);
    if (res._tag === "Failure") {
      setError("提交审批失败，请稍后重试。");
    }
  };

  return (
    <div className="space-y-2.5 rounded-xl border border-warning/50 bg-warning/8 p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-warning-foreground">
          <ShieldCheckIcon className="size-4" />
          <span>Needs you · 节点 {question.name} 等待人工拍板</span>
        </div>
        {question.thread ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              onOpenThread({
                threadId: question.thread!.threadId,
                environmentId: question.thread!.environmentId ?? null,
              })
            }
          >
            <MessageSquareIcon />
            <span>先看相关 Bot 会话</span>
          </Button>
        ) : null}
      </div>

      <p className="text-sm font-medium text-foreground">{view.title}</p>

      <input
        type="text"
        className="h-7.5 w-full rounded-md border border-input bg-background px-2.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring"
        placeholder="审批补充意见 / 驳回原因（部分选项必填）"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />

      <div className="flex flex-wrap gap-2">
        {view.choices.map((choice) => (
          <Button
            key={choice.value}
            size="sm"
            variant="outline"
            disabled={busy || !canAnswer}
            onClick={() => void pick(choice)}
          >
            <span>{choice.value}</span>
          </Button>
        ))}
      </div>

      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
    </div>
  );
}

export function LunaLiveCrewPanel({
  environmentId,
  overlay,
  questions,
  onOpenThread,
}: {
  readonly environmentId: EnvironmentId;
  readonly overlay: LiveFlowOverlay;
  readonly questions: ReadonlyArray<WorkflowQuestion>;
  readonly onOpenThread: (thread: WorkflowThreadTarget) => void;
}) {
  const activeCount = overlay.crew.filter((m) => m.status === "running").length;
  const doneCount = overlay.crew.filter((m) => m.status === "completed").length;

  return (
    <div className="mt-4 space-y-4">
      {/* Live Summary Strip */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card/70 px-3.5 py-2.5 text-xs">
        <span className="font-semibold text-foreground">多 Bot 实时协作状态</span>
        <Badge size="sm" variant="info">
          工作中 {activeCount}
        </Badge>
        <Badge size="sm" variant="success">
          已完成 {doneCount} / {overlay.crew.length}
        </Badge>
        {overlay.totalLoopHops > 0 ? (
          <Badge size="sm" variant="warning">
            已回流 {overlay.totalLoopHops} 轮
          </Badge>
        ) : null}
        {overlay.circuitBreakerCount > 0 ? (
          <Badge size="sm" variant="warning">
            触发熔断 {overlay.circuitBreakerCount} 次
          </Badge>
        ) : null}
      </div>

      {/* Inline Human Approvals */}
      {questions.map((question) => (
        <InlineApprovalCard
          key={`${question.name}:${question.askedAt}`}
          environmentId={environmentId}
          question={question}
          onOpenThread={onOpenThread}
        />
      ))}

      {/* Crew Roster Cards */}
      {overlay.crew.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
          此运行暂无 Bot Agent 节点。
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {overlay.crew.map((member) => {
            const status = STATUS_BADGE[member.status];
            return (
              <section
                key={member.nodeId}
                className="flex flex-col justify-between gap-3 rounded-xl border border-border bg-card p-3.5"
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <BotIcon className="size-4 shrink-0 text-info-foreground" />
                        <h3 className="truncate text-sm font-semibold text-foreground">
                          {member.botLabel}
                        </h3>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        节点：{member.nodeLabel} · {member.stepName}
                      </p>
                    </div>
                    <Badge size="sm" variant={status.variant}>
                      {status.label}
                      {member.visitCount > 1 ? ` #${member.visitCount}` : ""}
                    </Badge>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <Badge size="sm" variant="outline">
                      <GitForkIcon />
                      <span>{member.workspace}</span>
                    </Badge>
                    <Badge size="sm" variant="outline">
                      {member.runtimeMode}
                    </Badge>
                    {member.modelLabel ? (
                      <Badge size="sm" variant="outline">
                        {member.modelLabel}
                      </Badge>
                    ) : null}
                  </div>

                  {member.summary ? (
                    <p className="line-clamp-3 rounded-lg bg-muted/35 p-2 text-xs text-foreground">
                      {member.summary}
                    </p>
                  ) : null}
                </div>

                <div className="flex items-center justify-between border-t border-border pt-2">
                  <span className="font-mono text-xs text-muted-foreground">
                    {member.threadId ? `会话已关联` : "尚未启动会话"}
                  </span>
                  {member.threadId ? (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        onOpenThread({
                          threadId: member.threadId!,
                          environmentId: member.environmentId ?? null,
                        })
                      }
                    >
                      <MessageSquareIcon />
                      <span>查看 / 介入 (Steer)</span>
                    </Button>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
