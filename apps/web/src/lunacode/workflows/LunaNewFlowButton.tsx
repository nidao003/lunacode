import { useAtomValue } from "@effect/atom-react";
import {
  createStarterFlowSpec,
  FLOW_TEMPLATES,
  type FlowStarterTemplateId,
  formatFlowSpecJson,
  isFlowDefinitionFile,
  normalizeFlowFileName,
} from "@t3tools/client-runtime/lunacode/workflow-flow";
import type { EnvironmentId } from "@t3tools/contracts";
import { WorkflowIcon } from "lucide-react";
import { useState } from "react";

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
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export function LunaFlowFileBadge({ fileName }: { readonly fileName: string }) {
  if (!isFlowDefinitionFile(fileName)) return null;
  return (
    <Badge size="sm" variant="info">
      可视化流
    </Badge>
  );
}

export function LunaNewFlowButton({
  environmentId,
  onCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly onCreated: (fileName: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState<FlowStarterTemplateId>("parallel-review");
  const [rawName, setRawName] = useState("team-review");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? [];
  const save = useAtomCommand(serverEnvironment.saveWorkflowDefinition, {
    label: "new visual flow",
  });

  const handleCreate = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    const fileName = normalizeFlowFileName(rawName, "team-review");
    const defaultProvider = providers.find((p) => p.enabled && p.models.length > 0);
    const defaultModel =
      defaultProvider?.models.find((m) => m.isDefault) ?? defaultProvider?.models[0];
    const spec = createStarterFlowSpec({
      name: fileName.replace(/\.flow\.json$/i, ""),
      template,
      ...(projects[0]?.id ? { project: projects[0].id } : {}),
      ...(defaultProvider?.instanceId ? { providerInstanceId: defaultProvider.instanceId } : {}),
      ...(defaultModel?.slug ? { model: defaultModel.slug } : {}),
    });
    const result = await save({
      environmentId,
      input: {
        name: fileName,
        source: formatFlowSpecJson(spec),
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      setError("创建工作流失败，请确认文件名合法且服务已连接。");
      return;
    }
    setOpen(false);
    onCreated(fileName);
  };

  return (
    <>
      <Button size="sm" variant="default" onClick={() => setOpen(true)}>
        <WorkflowIcon />
        <span>新建可视化流</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>新建多 Bot 可视化工作流</DialogTitle>
            <DialogDescription>
              生成一个声明式的 `.flow.json` 编排文件，可在画布编辑器中可视化增改节点与协作 Bot。
            </DialogDescription>
          </DialogHeader>

          <DialogPanel>
            <div className="space-y-4">
              <label className="block space-y-1">
                <span className="block text-xs font-medium text-muted-foreground">
                  文件名（自动添加 .flow.json）
                </span>
                <input
                  type="text"
                  className="h-8 w-full rounded-md border border-input bg-background px-2.5 font-mono text-xs text-foreground outline-none focus-visible:border-ring"
                  placeholder="team-review"
                  value={rawName}
                  onChange={(e) => setRawName(e.target.value)}
                />
              </label>

              <div className="space-y-2">
                <span className="block text-xs font-medium text-muted-foreground">
                  选择起点模板
                </span>
                <div className="space-y-2">
                  {FLOW_TEMPLATES.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`flex w-full cursor-pointer flex-col gap-0.5 rounded-xl border p-3 text-left transition-colors ${
                        template === item.id
                          ? "border-primary bg-primary/8"
                          : "border-border bg-card hover:border-primary/45"
                      }`}
                      onClick={() => setTemplate(item.id)}
                    >
                      <span className="text-xs font-semibold text-foreground">{item.label}</span>
                      <span className="text-xs text-muted-foreground">{item.description}</span>
                    </button>
                  ))}
                </div>
              </div>

              {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
            </div>
          </DialogPanel>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button disabled={saving} onClick={() => void handleCreate()}>
              {saving ? "创建中..." : "创建并打开画布"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
