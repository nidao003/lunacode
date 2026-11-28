import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SEED_FLOW_TEMPLATES,
  createStarterFlowSpec,
  FLOW_TEMPLATES,
  type FlowStarterTemplateId,
  formatFlowSpecJson,
  isFlowDefinitionFile,
  normalizeFlowFileName,
} from "@t3tools/client-runtime/lunacode/workflow-flow";
import type { EnvironmentId } from "@t3tools/contracts";
import { FolderPlusIcon, WorkflowIcon } from "lucide-react";
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

export function LunaSeedDefaultFlowsButton({
  environmentId,
  existingFileNames,
  onSeeded,
}: {
  readonly environmentId: EnvironmentId;
  readonly existingFileNames: ReadonlyArray<string>;
  readonly onSeeded?: (firstFileName: string) => void;
}) {
  const [seeding, setSeeding] = useState(false);
  const existingSet = new Set(existingFileNames.map((name) => name.toLowerCase()));
  const missingTemplates = DEFAULT_SEED_FLOW_TEMPLATES.filter(
    (item) => !existingSet.has(item.defaultFileName.toLowerCase()),
  );

  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? [];
  const canSave = useAtomValue(
    serverEnvironment.saveWorkflowDefinition.permissionAtom(environmentId),
  );
  const save = useAtomCommand(serverEnvironment.saveWorkflowDefinition, {
    label: "seed default visual flows",
  });

  if (missingTemplates.length === 0) return null;

  const handleSeedAll = async () => {
    if (seeding || !canSave) return;
    setSeeding(true);
    const defaultProvider = providers.find((p) => p.enabled && p.models.length > 0);
    const defaultModel =
      defaultProvider?.models.find((m) => m.isDefault) ?? defaultProvider?.models[0];
    let firstCreated: string | null = null;
    for (const item of missingTemplates) {
      const spec = createStarterFlowSpec({
        name: item.defaultFileName.replace(/\.flow\.json$/i, ""),
        template: item.id,
        ...(projects[0]?.id ? { project: projects[0].id } : {}),
        ...(defaultProvider?.instanceId ? { providerInstanceId: defaultProvider.instanceId } : {}),
        ...(defaultModel?.slug ? { model: defaultModel.slug } : {}),
      });
      const result = await save({
        environmentId,
        input: {
          name: item.defaultFileName,
          source: formatFlowSpecJson(spec),
        },
      });
      if (result._tag === "Success" && !firstCreated) {
        firstCreated = item.defaultFileName;
      }
    }
    setSeeding(false);
    if (firstCreated) {
      onSeeded?.(firstCreated);
    }
  };

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={!canSave || seeding}
      onClick={() => void handleSeedAll()}
    >
      <FolderPlusIcon />
      <span>{seeding ? "导入中..." : `导入默认案例 (${missingTemplates.length})`}</span>
    </Button>
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
  const [template, setTemplate] = useState<FlowStarterTemplateId>("bug-repro-fix");
  const [rawName, setRawName] = useState("bug-repro-fix");
  const [nameEdited, setNameEdited] = useState(false);
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
    const fileName = normalizeFlowFileName(rawName, "bug-repro-fix");
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
        <DialogPopup className="max-w-xl">
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
                  placeholder="bug-repro-fix"
                  value={rawName}
                  onChange={(e) => {
                    setNameEdited(true);
                    setRawName(e.target.value);
                  }}
                />
              </label>

              <div className="space-y-2">
                <span className="block text-xs font-medium text-muted-foreground">
                  选择起点模板（共 {FLOW_TEMPLATES.length} 套精选场景）
                </span>
                <div className="max-h-[380px] space-y-2 overflow-y-auto pr-1">
                  {FLOW_TEMPLATES.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`flex w-full cursor-pointer flex-col gap-1 rounded-xl border p-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                        template === item.id
                          ? "border-primary bg-primary/8"
                          : "border-border bg-card hover:border-primary/45"
                      }`}
                      onClick={() => {
                        setTemplate(item.id);
                        if (!nameEdited) {
                          setRawName(item.defaultFileName.replace(/\.flow\.json$/i, ""));
                        }
                      }}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-1.5">
                        <span className="text-xs font-semibold text-foreground">{item.label}</span>
                        <div className="flex items-center gap-1">
                          <Badge size="sm" variant="outline">
                            {item.category}
                          </Badge>
                          <Badge size="sm" variant="info">
                            @{item.recommendedBotHandle}
                          </Badge>
                          <span className="font-mono text-3xs text-muted-foreground">
                            {item.recommendedTriggerHint}
                          </span>
                        </div>
                      </div>
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
