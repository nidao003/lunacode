import type { FlowDryRunReport, FlowSpec } from "@t3tools/contracts";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";

export function LunaFlowDryRunDialog({
  open,
  spec,
  report,
  onOpenChange,
  onJumpToNode,
}: {
  readonly open: boolean;
  readonly spec: FlowSpec;
  readonly report: FlowDryRunReport;
  readonly onOpenChange: (open: boolean) => void;
  readonly onJumpToNode: (nodeId: string) => void;
}) {
  const nodeLabels = new Map(spec.nodes.map((node) => [node.id, node.label]));
  const errorCount = report.issues.filter((issue) => issue.severity === "error").length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle>静态预演与安全审计 (Dry-Run)</DialogTitle>
            <Badge variant={report.valid ? "success" : "error"}>
              {report.valid ? "校验通过" : `${errorCount} 个阻断错误`}
            </Badge>
          </div>
          <DialogDescription>
            零 LLM 调用模拟阶段编排、并行 Worktree 冲突检查、有界回流以及外部 Payload 隔离范围。
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <div className="space-y-4">
            {/* Stage Execution Waves */}
            <div className="space-y-2">
              <p className="text-xs font-semibold text-foreground">
                阶段波次（共 {report.layers.length} 波 · 上限回流 {report.maxHops} 次）
              </p>
              <div className="space-y-1.5">
                {report.layers.map((layer) => (
                  <div
                    key={layer.index}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs"
                  >
                    <span className="font-medium text-muted-foreground">
                      阶段 {layer.index + 1}
                    </span>
                    {layer.parallel ? (
                      <Badge size="sm" variant="info">
                        并行 {layer.nodeIds.length}
                      </Badge>
                    ) : null}
                    <div className="flex flex-wrap gap-1.5">
                      {layer.nodeIds.map((id) => (
                        <button
                          key={id}
                          type="button"
                          className="cursor-pointer rounded border border-border bg-card px-2 py-0.5 font-mono text-xs text-foreground hover:border-primary"
                          onClick={() => {
                            onJumpToNode(id);
                            onOpenChange(false);
                          }}
                        >
                          {nodeLabels.get(id) ?? id}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Security & Untrusted Data */}
            {report.untrustedDataFields.length > 0 ? (
              <div className="space-y-1 rounded-lg border border-border bg-muted/20 p-3 text-xs">
                <p className="font-semibold text-foreground">非信任 Payload 自动沙箱隔离字段</p>
                <p className="font-mono text-muted-foreground">
                  {report.untrustedDataFields.join(", ")}
                </p>
              </div>
            ) : null}

            {/* Issues List */}
            {report.issues.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-foreground">
                  检查项（{report.issues.length}）
                </p>
                <ul className="space-y-1.5">
                  {report.issues.map((issue) => (
                    <li
                      key={`${issue.code}:${issue.nodeId ?? issue.edgeId ?? issue.botId ?? issue.message}`}
                      className="flex items-start justify-between gap-2 rounded-lg border border-border p-2.5 text-xs"
                    >
                      <div className="space-y-0.5">
                        <Badge size="sm" variant={issue.severity === "error" ? "error" : "warning"}>
                          {issue.severity === "error" ? "阻断错误" : "风险提示"}
                        </Badge>
                        <p className="text-foreground">{issue.message}</p>
                      </div>
                      {issue.nodeId ? (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => {
                            if (issue.nodeId) onJumpToNode(issue.nodeId);
                            onOpenChange(false);
                          }}
                        >
                          定位节点
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </DialogPanel>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
