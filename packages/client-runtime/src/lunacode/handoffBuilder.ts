import type { OrchestrationV2PlanArtifact, OrchestrationV2TurnItem } from "@t3tools/contracts";
import type { ThreadStructureVisibleTurnItem } from "../state/models.ts";

export interface BuildDeterministicHandoffInput {
  readonly threadTitle?: string | null | undefined;
  readonly branch?: string | null | undefined;
  readonly model?: string | null | undefined;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly text: string;
  }>;
  readonly visibleTurnItems: ReadonlyArray<
    ThreadStructureVisibleTurnItem | { readonly item: OrchestrationV2TurnItem }
  >;
  readonly plans?: ReadonlyArray<OrchestrationV2PlanArtifact> | undefined;
  readonly maxChars?: number | undefined;
}

export interface DeterministicHandoffResult {
  readonly markdown: string;
  readonly charCount: number;
  readonly estimatedTokens: number;
  readonly stats: {
    readonly filesCount: number;
    readonly completedSteps: number;
    readonly pendingSteps: number;
  };
}

const DEFAULT_HANDOFF_MAX_CHARS = 3000;
const HANDOFF_FOOTER = "请基于以上上下文继续推进，无需重复全量复述。";

function compactExcerpt(raw: string, limit: number): string {
  const normalized = raw
    .replaceAll(/\r\n/g, "\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function isCompactionOnlyPrompt(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return lower === "/compact" || lower.startsWith("/compact ");
}

function collectFileChanges(
  visibleTurnItems: BuildDeterministicHandoffInput["visibleTurnItems"],
): ReadonlyArray<string> {
  const seen = new Set<string>();
  for (const entry of visibleTurnItems) {
    const raw = entry.item as Record<string, unknown>;
    if (raw.type !== "file_change") continue;
    if (typeof raw.fileName === "string" && raw.fileName.trim().length > 0) {
      seen.add(raw.fileName.trim());
    }
    if (Array.isArray(raw.changes)) {
      for (const change of raw.changes) {
        if (
          typeof change === "object" &&
          change !== null &&
          "path" in change &&
          typeof change.path === "string" &&
          change.path.trim().length > 0
        ) {
          seen.add(change.path.trim());
        }
      }
    }
  }
  return [...seen];
}

interface CommandSummary {
  readonly input: string;
  readonly failed: boolean;
  readonly exitCode: number | null;
}

function collectNotableCommands(
  visibleTurnItems: BuildDeterministicHandoffInput["visibleTurnItems"],
): ReadonlyArray<CommandSummary> {
  const commands: CommandSummary[] = [];
  for (const entry of visibleTurnItems) {
    const raw = entry.item as Record<string, unknown>;
    if (raw.type !== "command_execution" || typeof raw.input !== "string") continue;
    const cmd = raw.input.replaceAll(/\s+/g, " ").trim();
    if (!cmd) continue;
    const exitCode = typeof raw.exitCode === "number" ? raw.exitCode : null;
    const failed = raw.outputIndicatesFailure === true || (exitCode !== null && exitCode !== 0);
    commands.push({
      input: compactExcerpt(cmd, 110),
      failed,
      exitCode,
    });
  }

  // Prioritize failures first, then most recent commands up to 6 entries.
  const failures = commands.filter((item) => item.failed);
  const recentNonFailures = commands.filter((item) => !item.failed).slice(-4);
  const combined = [...failures.slice(-3), ...recentNonFailures];
  return combined.slice(-6);
}

export function buildDeterministicHandoff(
  input: BuildDeterministicHandoffInput,
): DeterministicHandoffResult {
  const maxChars = Math.max(120, Math.round(input.maxChars ?? DEFAULT_HANDOFF_MAX_CHARS));

  const userMessages = input.messages.filter(
    (msg) => msg.role === "user" && msg.text.trim().length > 0 && !isCompactionOnlyPrompt(msg.text),
  );
  const firstUser = userMessages[0] ?? null;
  const latestUser =
    userMessages.length > 1 ? (userMessages[userMessages.length - 1] ?? null) : null;
  const latestAssistant =
    [...input.messages]
      .reverse()
      .find((msg) => msg.role === "assistant" && msg.text.trim().length > 0) ?? null;

  const files = collectFileChanges(input.visibleTurnItems);
  const commands = collectNotableCommands(input.visibleTurnItems);

  const plans = input.plans ?? [];
  const todoPlan =
    plans.find((plan) => plan.kind === "todo_list" && plan.status === "active") ??
    [...plans].reverse().find((plan) => plan.kind === "todo_list") ??
    null;
  const proposedPlan =
    plans.find((plan) => plan.kind === "proposed_plan" && plan.status !== "superseded") ?? null;

  let completedSteps = 0;
  let pendingSteps = 0;
  const pendingStepLabels: string[] = [];
  const completedStepLabels: string[] = [];

  if (todoPlan && todoPlan.kind === "todo_list") {
    for (const step of todoPlan.steps) {
      if (step.status === "completed") {
        completedSteps += 1;
        completedStepLabels.push(step.text);
      } else {
        pendingSteps += 1;
        pendingStepLabels.push(step.text);
      }
    }
  }

  const lines: string[] = ["# 会话交接摘要（LunaCode 本地结构化生成）"];
  lines.push(`- 原会话：${input.threadTitle?.trim() || "未命名会话"}`);
  if (input.branch?.trim()) {
    lines.push(`- 分支：${input.branch.trim()}`);
  }
  if (input.model?.trim()) {
    lines.push(`- 模型：${input.model.trim()}`);
  }

  lines.push("");
  lines.push("## 原始目标与最新诉求");
  if (firstUser) {
    lines.push(`- 初始目标：${compactExcerpt(firstUser.text, 420)}`);
    if (latestUser && latestUser.text.trim() !== firstUser.text.trim()) {
      lines.push(`- 最新诉求：${compactExcerpt(latestUser.text, 520)}`);
    }
  } else {
    lines.push("- 暂无用户输入记录");
  }

  lines.push("");
  lines.push("## 涉及文件与关键命令");
  if (files.length > 0) {
    lines.push(`- 改动文件（共 ${files.length} 个）：`);
    for (const file of files.slice(0, 20)) {
      lines.push(`  - \`${file}\``);
    }
    if (files.length > 20) {
      lines.push(`  - ...其余 ${files.length - 20} 个文件已省略`);
    }
  } else {
    lines.push("- 改动文件：暂无记录");
  }

  if (commands.length > 0) {
    lines.push("- 关键命令执行：");
    for (const cmd of commands) {
      const status = cmd.failed
        ? cmd.exitCode !== null
          ? `失败 exit ${cmd.exitCode}`
          : "失败"
        : "完成";
      lines.push(`  - [${status}] \`${cmd.input}\``);
    }
  }

  lines.push("");
  lines.push("## 计划进度与最近结论");
  if (todoPlan && todoPlan.kind === "todo_list") {
    lines.push(`- 任务清单：已完成 ${completedSteps} 项，待处理 ${pendingSteps} 项`);
    for (const step of pendingStepLabels.slice(0, 8)) {
      lines.push(`  - [ ] ${compactExcerpt(step, 140)}`);
    }
    for (const step of completedStepLabels.slice(-4)) {
      lines.push(`  - [x] ${compactExcerpt(step, 120)}`);
    }
  } else if (proposedPlan && proposedPlan.kind === "proposed_plan") {
    lines.push(`- 方案摘要：${compactExcerpt(proposedPlan.markdown, 380)}`);
  }

  if (latestAssistant) {
    lines.push(`- 最近助手结论：\n${compactExcerpt(latestAssistant.text, 750)}`);
  } else {
    lines.push("- 最近助手结论：暂无记录");
  }

  lines.push("");
  lines.push(HANDOFF_FOOTER);

  let markdown = lines.join("\n");
  if (markdown.length > maxChars) {
    const suffix = `\n...\n${HANDOFF_FOOTER}`;
    if (maxChars <= suffix.length + 16) {
      markdown = markdown.slice(0, maxChars);
    } else {
      markdown = `${markdown.slice(0, maxChars - suffix.length).trimEnd()}${suffix}`;
    }
  }

  return {
    markdown,
    charCount: markdown.length,
    estimatedTokens: Math.ceil(markdown.length / 3.5),
    stats: {
      filesCount: files.length,
      completedSteps,
      pendingSteps,
    },
  };
}
