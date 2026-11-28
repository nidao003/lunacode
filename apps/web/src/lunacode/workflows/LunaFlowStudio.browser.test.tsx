import {
  createStarterFlowSpec,
  formatFlowSpecJson,
} from "@t3tools/client-runtime/lunacode/workflow-flow";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { LunaFlowStudio } from "./LunaFlowStudio";

const ENV_ID = EnvironmentId.make("env-1");
const PROJECT_ID = ProjectId.make("project-1");

const hoisted = vi.hoisted(() => ({
  commands: [] as Array<{ readonly label: string; readonly payload: unknown }>,
  permittedAtom: null as Atom.Atom<boolean> | null,
  providersAtom: null as Atom.Atom<ReadonlyArray<unknown>> | null,
}));

vi.mock(import("../../state/entities"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useProjects: () => [
      {
        id: PROJECT_ID,
        environmentId: ENV_ID,
        title: "Main Repo",
        workspaceRoot: "/workspace/main",
        defaultModelSelection: null,
        scripts: [],
        repositoryIdentity: null,
        createdAt: "2026-11-28T00:00:00.000Z",
        updatedAt: "2026-11-28T00:00:00.000Z",
      } as never,
    ],
  };
});

vi.mock(import("../../state/use-atom-command"), (() => ({
  useAtomCommand:
    (_command: unknown, opts?: { readonly label?: string }) => async (payload: unknown) => {
      hoisted.commands.push({ label: opts?.label ?? "unknown", payload });
      if (opts?.label === "flow studio start") {
        return { _tag: "Success", value: { runId: "run-999" } } as never;
      }
      return { _tag: "Success", value: { changed: true, problems: [] } } as never;
    },
})) as never);

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const permitted = Atom.make(true);
  const providers = Atom.make([
    {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-11-28T00:00:00.000Z",
      models: [{ slug: "gpt-5", name: "GPT-5", isCustom: false, isDefault: true }],
      slashCommands: [],
      skills: [],
    },
  ]);
  hoisted.permittedAtom = permitted;
  hoisted.providersAtom = providers;
  const permissionAtom = () => permitted;
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providersValueAtom: () => providers as never,
      saveWorkflowDefinition: {
        ...actual.serverEnvironment.saveWorkflowDefinition,
        permissionAtom,
      },
      startWorkflowRun: {
        ...actual.serverEnvironment.startWorkflowRun,
        permissionAtom,
      },
    },
  };
});

describe("LunaFlowStudio", () => {
  it("renders canvas nodes, updates node label in inspector, previews dry-run, saves v2, and runs", async () => {
    hoisted.commands = [];
    const openedFiles: Array<string | null> = [];
    const spec = createStarterFlowSpec({
      name: "demo-flow",
      template: "parallel-review",
      project: "project-1",
    });

    await using screen = await render(
      <div className="flex h-dvh flex-col">
        <LunaFlowStudio
          environmentId={ENV_ID}
          name="demo.flow.json"
          source={formatFlowSpecJson(spec)}
          revision={1}
          onDisk={[]}
          offline={false}
          onClose={() => openedFiles.push(null)}
          onOpenFile={(file) => openedFiles.push(file)}
          actions={null}
        />
      </div>,
    );

    await expect.element(screen.getByText("并行功能实现")).toBeVisible();
    await expect.element(screen.getByText("联合代码评审")).toBeVisible();

    // Select node and rename in inspector
    await userEvent.click(screen.getByText("并行功能实现"));
    const labelInput = screen.getByLabelText("节点名称");
    await expect.element(labelInput).toBeVisible();
    await userEvent.clear(labelInput);
    await userEvent.type(labelInput, "并行研发 A");
    await expect.element(screen.getByText("并行研发 A")).toBeVisible();

    // Open Dry-Run dialog and close
    await userEvent.click(screen.getByRole("button", { name: "预演" }));
    await expect.element(page.getByText("静态预演与安全审计 (Dry-Run)")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "关闭" }));

    // Create v2
    await userEvent.click(screen.getByRole("button", { name: "创建 v2" }));
    const v2Call = hoisted.commands.find((c) => c.label === "flow studio save");
    expect(v2Call).toBeDefined();
    expect((v2Call!.payload as { readonly input: { readonly name: string } }).input.name).toBe(
      "demo.v2.flow.json",
    );
    expect(openedFiles).toContain("demo.v2.flow.json");

    // Start immediate run
    await userEvent.click(screen.getByRole("button", { name: "立即运行" }));
    const startCall = hoisted.commands.find((c) => c.label === "flow studio start");
    expect(startCall).toBeDefined();
    expect(
      (startCall!.payload as { readonly input: { readonly workflow: string } }).input.workflow,
    ).toBe("demo-flow");
  });
});
