import type { FlowSpec } from "@t3tools/contracts";

export type FlowStarterTemplateId =
  | "bug-repro-fix"
  | "pr-dual-review"
  | "ci-doctor-autofix"
  | "docs-drift-sync"
  | "release-notes-prep"
  | "daily-repo-standup"
  | "issue-triage"
  | "feature-plan-ship"
  // Legacy aliases kept for backward compatibility with older scripts & tests.
  | "parallel-review"
  | "human-gate"
  | "single-agent";

export interface FlowStarterTemplateMeta {
  readonly id: FlowStarterTemplateId;
  readonly defaultFileName: string;
  readonly label: string;
  readonly category: string;
  readonly recommendedBotHandle: string;
  readonly recommendedTriggerHint: string;
  readonly description: string;
  readonly seedByDefault: boolean;
}

export const FLOW_TEMPLATES: ReadonlyArray<FlowStarterTemplateMeta> = [
  {
    id: "bug-repro-fix",
    defaultFileName: "bug-repro-fix.flow.json",
    label: "Bug 复现与并行修复",
    category: "研发修复",
    recommendedBotHandle: "scout",
    recommendedTriggerHint: "manual · issues.opened",
    description:
      "苏探分诊 -> 双 Worktree 并行写复现单测 & 最小修复 -> 林清闭环复核（含熔断）-> 人工批准发布",
    seedByDefault: true,
  },
  {
    id: "pr-dual-review",
    defaultFileName: "pr-dual-review.flow.json",
    label: "PR 质量与安全双审",
    category: "代码评审",
    recommendedBotHandle: "review-buddy",
    recommendedTriggerHint: "manual · pullRequests.opened",
    description: "逻辑回归审查 & OWASP 安全审查并行只读 -> 汇总 P0/P1/P2 风险清单 -> 人工定稿放行",
    seedByDefault: true,
  },
  {
    id: "ci-doctor-autofix",
    defaultFileName: "ci-doctor-autofix.flow.json",
    label: "CI 故障诊断与自愈",
    category: "稳定性监控",
    recommendedBotHandle: "ci-watch",
    recommendedTriggerHint: "manual · every / webhook",
    description:
      "本地脚本采集状态 (onFailure: branch) -> CI 医生定性 Flaky/回归 -> 隔离 Worktree 补丁 -> 评审闭环 -> 人工采纳",
    seedByDefault: true,
  },
  {
    id: "docs-drift-sync",
    defaultFileName: "docs-drift-sync.flow.json",
    label: "代码与文档漂移同步",
    category: "文档协同",
    recommendedBotHandle: "docs-helper",
    recommendedTriggerHint: "manual · daily + precheck",
    description:
      "零 Token precheck 门槛 -> 扫描代码与文档漂移 -> 无漂移零写入跳过，有漂移则在 Worktree 更新待审",
    seedByDefault: true,
  },
  {
    id: "release-notes-prep",
    defaultFileName: "release-notes-prep.flow.json",
    label: "发版日志与交付把关",
    category: "发布交付",
    recommendedBotHandle: "release-notes",
    recommendedTriggerHint: "manual · webhook",
    description: "按破坏性变更/特性/修复归纳中英文 Release Notes -> 核验遗漏闭环 -> 人工定稿门",
    seedByDefault: true,
  },
  {
    id: "daily-repo-standup",
    defaultFileName: "daily-repo-standup.flow.json",
    label: "每日进展与仓库巡检",
    category: "日常洞察",
    recommendedBotHandle: "standup",
    recommendedTriggerHint: "manual · daily 09:30",
    description: "只读聚合近 24h 提交、活跃分支与阻塞项，生成结构化研发站会简报",
    seedByDefault: true,
  },
  {
    id: "issue-triage",
    defaultFileName: "issue-triage.flow.json",
    label: "Issue 智能分诊与转修",
    category: "研发修复",
    recommendedBotHandle: "scout",
    recommendedTriggerHint: "issues.opened · manual",
    description:
      "只读解析 Issue 分类与缺失信息 -> 人工拍板（直接派工修复 / 仅回复分诊 / 暂缓归档）-> 条件落地",
    seedByDefault: false,
  },
  {
    id: "feature-plan-ship",
    defaultFileName: "feature-plan-ship.flow.json",
    label: "Plan 先行与安全网交付",
    category: "架构交付",
    recommendedBotHandle: "scout",
    recommendedTriggerHint: "manual",
    description: "Plan 只读出方案 -> 人工批准方案门 -> 隔离 Worktree 全权实现 -> Reviewer 验收回流",
    seedByDefault: false,
  },
];

export const DEFAULT_SEED_FLOW_TEMPLATES: ReadonlyArray<FlowStarterTemplateMeta> =
  FLOW_TEMPLATES.filter((item) => item.seedByDefault);

function sanitizeFlowIdentifier(input: string, fallback = "custom-flow"): string {
  const cleaned = input
    .trim()
    .replace(/\.flow\.json$/i, "")
    .replace(/\.json$/i, "")
    .replace(/[^A-Za-z0-9_@-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 64) : fallback;
}

export function formatFlowSpecJson(spec: FlowSpec): string {
  return `${JSON.stringify(spec, null, 2)}\n`;
}

export function createStarterFlowSpec(opts: {
  readonly name: string;
  readonly template?: FlowStarterTemplateId;
  readonly project?: string;
  readonly providerInstanceId?: string;
  readonly model?: string;
}): FlowSpec {
  const safeName = sanitizeFlowIdentifier(opts.name, "team-flow");
  const project =
    opts.project && opts.project.trim().length > 0 ? opts.project.trim() : "default-project";
  const providerMeta =
    opts.providerInstanceId && opts.model
      ? { providerInstanceId: opts.providerInstanceId, model: opts.model }
      : {};
  const template = opts.template ?? "bug-repro-fix";

  if (template === "single-agent") {
    return {
      schemaVersion: 1,
      name: safeName,
      version: 1,
      title: "单 Bot 自动任务",
      description: "由单个智能体独立完成任务并在结束时输出总结。",
      maxHops: 2,
      bots: {
        worker: {
          label: "执行 Bot",
          runtimeMode: "approval-required",
          interactionMode: "default",
          workspace: "root",
          rolePrompt: "仔细分析需求并交付可验证的结果。",
          ...providerMeta,
        },
      },
      triggers: [{ kind: "manual" }],
      nodes: [
        {
          id: "run_task",
          kind: "agent",
          label: "执行核心任务",
          botId: "worker",
          project,
          promptTemplate: "请完成以下任务：\n{{payload.task}}",
        },
        {
          id: "done",
          kind: "end",
          label: "完成结束",
          outcome: "complete",
          reasonTemplate: "任务已完成",
        },
      ],
      edges: [
        { id: "e1", from: "trigger", to: "run_task" },
        { id: "e2", from: "run_task", to: "done" },
      ],
    };
  }

  if (template === "human-gate") {
    return {
      schemaVersion: 1,
      name: safeName,
      version: 1,
      title: "方案评审与执行流",
      description: "先出方案与排查，再经人类拍板后执行修改。",
      maxHops: 2,
      bots: {
        planner: {
          label: "架构 Planner",
          runtimeMode: "approval-required",
          interactionMode: "plan",
          workspace: "root",
          rolePrompt: "先调研代码库现状与影响面，给出清晰的修改方案。",
          ...providerMeta,
        },
        executor: {
          label: "工程 Executor",
          runtimeMode: "approval-required",
          interactionMode: "default",
          workspace: "worktree",
          workspaceBaseRef: "HEAD",
          rolePrompt: "按已批准的方案实现代码改动并运行相关测试。",
          ...providerMeta,
        },
      },
      triggers: [{ kind: "manual" }],
      nodes: [
        {
          id: "plan",
          kind: "agent",
          label: "制定方案",
          botId: "planner",
          project,
          promptTemplate: "请针对以下需求制定方案：\n{{payload.task}}",
          returns: [{ name: "summary", type: "string", description: "方案摘要" }],
        },
        {
          id: "approve_plan",
          kind: "gate",
          label: "方案人工确认",
          gateMode: "human",
          askKind: "plan_approval",
          titleTemplate: "是否按以下方案继续执行？",
          choices: [
            { value: "批准执行", description: "进入执行节点落地代码" },
            { value: "打回重做", description: "返回 Planner 重新调整", requireReason: true },
            { value: "取消中止", description: "结束本次工作流" },
          ],
        },
        {
          id: "execute",
          kind: "agent",
          label: "落地实现",
          botId: "executor",
          project,
          promptTemplate:
            "已获人工批准，请实现方案：\n摘要：{{nodes.plan.value.summary}}\n补充意见：{{nodes.approve_plan.reason}}",
        },
        {
          id: "done",
          kind: "end",
          label: "交付完成",
          outcome: "complete",
        },
        {
          id: "aborted",
          kind: "end",
          label: "已取消",
          outcome: "stop",
          reasonTemplate: "人工取消：{{nodes.approve_plan.reason}}",
        },
      ],
      edges: [
        { id: "e1", from: "trigger", to: "plan" },
        { id: "e2", from: "plan", to: "approve_plan" },
        {
          id: "e3",
          from: "approve_plan",
          to: "execute",
          when: "nodes.approve_plan.choice == '批准执行'",
        },
        {
          id: "e4",
          from: "approve_plan",
          to: "plan",
          when: "nodes.approve_plan.choice == '打回重做'",
          isLoop: true,
        },
        {
          id: "e5",
          from: "approve_plan",
          to: "aborted",
          when: "nodes.approve_plan.choice == '取消中止'",
        },
        { id: "e6", from: "execute", to: "done" },
      ],
    };
  }

  if (template === "parallel-review") {
    return {
      schemaVersion: 1,
      name: safeName,
      version: 1,
      title: "并行多 Bot 协作与评审流",
      description:
        "两个独立 Worktree Bot 并行研发与验证，汇总给 Reviewer 评审，未通过可有限回流修复，最后人工确认。",
      maxHops: 2,
      bots: {
        coder: {
          label: "研发 Bot",
          runtimeMode: "full-access",
          interactionMode: "default",
          workspace: "worktree",
          workspaceBaseRef: "HEAD",
          rolePrompt: "专注实现改动并确保局部可构建。",
          ...providerMeta,
        },
        tester: {
          label: "测试 Bot",
          runtimeMode: "full-access",
          interactionMode: "default",
          workspace: "worktree",
          workspaceBaseRef: "HEAD",
          rolePrompt: "编写覆盖边界条件的自动化测试并验证回归。",
          ...providerMeta,
        },
        reviewer: {
          label: "评审 Bot",
          runtimeMode: "approval-required",
          interactionMode: "plan",
          workspace: "root",
          rolePrompt: "严格审查改动正确性与测试覆盖率，并输出结构化结论。",
          ...providerMeta,
        },
      },
      triggers: [{ kind: "manual" }],
      nodes: [
        {
          id: "implement",
          kind: "agent",
          label: "并行功能实现",
          botId: "coder",
          project,
          promptTemplate: "请在隔离 worktree 中完成任务：{{payload.task}}",
          returns: [{ name: "summary", type: "string", description: "实现说明" }],
        },
        {
          id: "write_tests",
          kind: "agent",
          label: "并行补充测试",
          botId: "tester",
          project,
          promptTemplate: "请为以下任务设计并编写测试：{{payload.task}}",
          returns: [{ name: "checks", type: "string", description: "测试运行结论" }],
        },
        {
          id: "review",
          kind: "agent",
          label: "联合代码评审",
          botId: "reviewer",
          project,
          promptTemplate:
            "请评审研发与测试产出：\n实现：{{nodes.implement.value.summary}}\n测试：{{nodes.write_tests.value.checks}}",
          returns: [
            { name: "approved", type: "boolean", description: "是否通过评审" },
            { name: "notes", type: "string", description: "评审意见" },
          ],
        },
        {
          id: "approve_ship",
          kind: "gate",
          label: "人工发布审批",
          gateMode: "coordinator_then_human",
          askKind: "ship_approval",
          titleTemplate: "所有检查已通过，是否合并并发布？",
          choices: [
            { value: "批准发布", description: "完成本次工作流" },
            { value: "继续打磨", description: "打回给研发节点微调", requireReason: true },
          ],
        },
        {
          id: "done",
          kind: "end",
          label: "流程完成",
          outcome: "complete",
          reasonTemplate: "评审与人工确认均已通过",
        },
      ],
      edges: [
        { id: "e1", from: "trigger", to: "implement" },
        { id: "e2", from: "trigger", to: "write_tests" },
        { id: "e3", from: "implement", to: "review" },
        { id: "e4", from: "write_tests", to: "review" },
        {
          id: "e5",
          from: "review",
          to: "approve_ship",
          when: "nodes.review.value.approved == true",
        },
        {
          id: "e6",
          from: "review",
          to: "implement",
          when: "!nodes.review.value.approved",
          isLoop: true,
        },
        {
          id: "e7",
          from: "approve_ship",
          to: "done",
          when: "nodes.approve_ship.choice == '批准发布'",
        },
        {
          id: "e8",
          from: "approve_ship",
          to: "implement",
          when: "nodes.approve_ship.choice == '继续打磨'",
          isLoop: true,
        },
      ],
    };
  }

  if (template === "pr-dual-review") {
    return {
      schemaVersion: 1,
      name: safeName,
      version: 1,
      title: "PR 质量与安全双审",
      description:
        "并行的只读逻辑评审官与安全审计官独立检查 diff，再汇总为分级结论由人类拍板放行。推荐配置 pullRequests.opened 触发器自动审查新 PR。",
      concurrency: 2,
      maxHops: 2,
      bots: {
        logic_reviewer: {
          label: "林清 · 逻辑官",
          runtimeMode: "approval-required",
          interactionMode: "plan",
          workspace: "root",
          rolePrompt: "专注检查代码正确性、回归风险、边界条件、性能回退与测试覆盖度。",
          ...providerMeta,
        },
        security_reviewer: {
          label: "沈岚 · 安全审计",
          runtimeMode: "approval-required",
          interactionMode: "plan",
          workspace: "root",
          rolePrompt:
            "专注 OWASP Top 10、注入攻击、路径穿越、越权访问、硬编码密钥与敏感数据暴露风险。",
          ...providerMeta,
        },
        lead_reviewer: {
          label: "林清 · 主评审汇总",
          runtimeMode: "approval-required",
          interactionMode: "plan",
          workspace: "root",
          rolePrompt: "合并逻辑评审与安全审计结论，去重并按 P0/P1/P2 输出清晰可执行的行动清单。",
          ...providerMeta,
        },
      },
      triggers: [{ kind: "manual" }],
      nodes: [
        {
          id: "logic_review",
          kind: "agent",
          label: "逻辑与回归审查",
          botId: "logic_reviewer",
          project,
          promptTemplate:
            "请以只读方式审查目标改动/PR（排查回归、边界条件、类型安全与测试缺失）：\n{{payload.task}}",
          returns: [
            { name: "findings", type: "string", description: "逻辑与测试审查发现" },
            { name: "riskLevel", type: "string", description: "low / medium / high" },
          ],
        },
        {
          id: "security_review",
          kind: "agent",
          label: "安全与合规审计",
          botId: "security_reviewer",
          project,
          promptTemplate:
            "请以只读方式扫描目标改动/PR 中的安全隐患、凭据泄漏与权限边界问题：\n{{payload.task}}",
          returns: [
            { name: "findings", type: "string", description: "安全审计发现" },
            { name: "criticalCount", type: "number", description: "高危安全问题数量" },
          ],
        },
        {
          id: "synthesize_review",
          kind: "agent",
          label: "汇总分级评审报告",
          botId: "lead_reviewer",
          project,
          promptTemplate:
            "请将两路评审意见整合为 P0/P1/P2 清单：\n[逻辑审查] ({{nodes.logic_review.value.riskLevel}}): {{nodes.logic_review.value.findings}}\n[安全审计] (高危 {{nodes.security_review.value.criticalCount}} 项): {{nodes.security_review.value.findings}}",
          returns: [
            { name: "summary", type: "string", description: "最终评审结论摘要" },
            { name: "blockingCount", type: "number", description: "阻断合并项数量" },
          ],
        },
        {
          id: "human_verdict",
          kind: "gate",
          label: "人工评审裁决",
          gateMode: "human",
          askKind: "review_decision",
          titleTemplate:
            "PR 双审报告已出（阻断项：{{nodes.synthesize_review.value.blockingCount}}），请确认处理决定",
          choices: [
            { value: "通过可合并", description: "确认风险可控，允许推进合并" },
            { value: "要求修改后复审", description: "标记需修复后再提交审校", requireReason: true },
            { value: "仅记录意见", description: "保留本次审查建议并结束" },
          ],
        },
        {
          id: "done_approved",
          kind: "end",
          label: "审查通过",
          outcome: "complete",
          reasonTemplate: "双审通过：{{nodes.synthesize_review.value.summary}}",
        },
        {
          id: "done_changes_requested",
          kind: "end",
          label: "退回修改",
          outcome: "stop",
          reasonTemplate: "要求修改：{{nodes.human_verdict.reason}}",
        },
      ],
      edges: [
        { id: "e1", from: "trigger", to: "logic_review" },
        { id: "e2", from: "trigger", to: "security_review" },
        { id: "e3", from: "logic_review", to: "synthesize_review" },
        { id: "e4", from: "security_review", to: "synthesize_review" },
        { id: "e5", from: "synthesize_review", to: "human_verdict" },
        {
          id: "e6",
          from: "human_verdict",
          to: "done_approved",
          when: "nodes.human_verdict.choice == '通过可合并' || nodes.human_verdict.choice == '仅记录意见'",
        },
        {
          id: "e7",
          from: "human_verdict",
          to: "done_changes_requested",
          when: "nodes.human_verdict.choice == '要求修改后复审'",
        },
      ],
    };
  }

  if (template === "ci-doctor-autofix") {
    return {
      schemaVersion: 1,
      name: safeName,
      version: 1,
      title: "CI 故障诊断与自愈",
      description:
        "先用本地检查脚本采集现场（onFailure: branch 失败不中止），再由夏哨定位根因；若为确定性回归则在隔离 Worktree 起草最小补丁并闭环复验。推荐按需绑定 Webhook 或 every 巡检。",
      concurrency: 1,
      maxHops: 2,
      bots: {
        ci_doctor: {
          label: "夏哨 · CI 医生",
          runtimeMode: "approval-required",
          interactionMode: "plan",
          workspace: "root",
          rolePrompt:
            "分析 CI / 测试 / 构建失败堆栈与最近变更，精确区分偶发 Flaky 与确定性回归，并给出最小修复方案。",
          ...providerMeta,
        },
        ci_fixer: {
          label: "夏哨 · 隔离修复 Worker",
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
          workspace: "worktree",
          workspaceBaseRef: "HEAD",
          rolePrompt: "仅实施最小修复补丁并运行相关检查，绝不顺手重构无关文件。",
          ...providerMeta,
        },
        reviewer: {
          label: "林清 · 补丁守门",
          runtimeMode: "approval-required",
          interactionMode: "plan",
          workspace: "root",
          rolePrompt: "核验 CI 修复补丁是否真正根除故障且不引入新回归。",
          ...providerMeta,
        },
      },
      triggers: [{ kind: "manual" }],
      nodes: [
        {
          id: "collect_ci_state",
          kind: "script",
          label: "采集构建/仓库状态",
          command: ["git", "status", "--short"],
          cwd: ".",
          timeoutSeconds: 60,
          onFailure: "branch",
        },
        {
          id: "diagnose_ci",
          kind: "agent",
          label: "CI 根因诊断",
          botId: "ci_doctor",
          project,
          promptTemplate:
            "请诊断本次检查失败的根本原因。\n外部触发/日志：{{payload.task}}\n前置脚本状态：{{nodes.collect_ci_state.outcome}}\n脚本输出：{{nodes.collect_ci_state.value.stdout}}\n失败详情：{{nodes.collect_ci_state.reason}}",
          returns: [
            { name: "isFlaky", type: "boolean", description: "是否判断为偶发 Flaky 抖动" },
            { name: "rootCause", type: "string", description: "根因定性摘要" },
            { name: "fixPlan", type: "string", description: "最小修复步骤" },
          ],
        },
        {
          id: "flaky_notice",
          kind: "gate",
          label: "偶发抖动处理确认",
          gateMode: "human",
          askKind: "ci_flaky_check",
          titleTemplate: "夏哨诊断可能为偶发 Flaky：{{nodes.diagnose_ci.value.rootCause}}",
          choices: [
            { value: "仅记录并跳过修复", description: "确认无需改代码，保留排查报告" },
            { value: "停止排查", description: "立即结束本次诊断" },
          ],
        },
        {
          id: "draft_autofix",
          kind: "agent",
          label: "隔离 Worktree 最小修复",
          botId: "ci_fixer",
          project,
          promptTemplate:
            "请按照根因分析在隔离 Worktree 起草最小修复并运行关联验证：\n根因：{{nodes.diagnose_ci.value.rootCause}}\n修复计划：{{nodes.diagnose_ci.value.fixPlan}}\n评审反馈（若有）：{{nodes.verify_fix.value.notes}}",
          returns: [{ name: "patchSummary", type: "string", description: "修复补丁与验证输出" }],
        },
        {
          id: "verify_fix",
          kind: "agent",
          label: "林清复核补丁",
          botId: "reviewer",
          project,
          promptTemplate:
            "请复核 CI 自动修复补丁是否干净安全、测试通过：\n{{nodes.draft_autofix.value.patchSummary}}",
          returns: [
            { name: "approved", type: "boolean", description: "补丁是否通过复核" },
            { name: "notes", type: "string", description: "复核结论或修改建议" },
          ],
        },
        {
          id: "approve_patch",
          kind: "gate",
          label: "人工采纳补丁审批",
          gateMode: "human",
          askKind: "ci_autofix_approval",
          titleTemplate: "CI 修复补丁已通过核验，是否采纳？",
          choices: [
            { value: "采纳补丁", description: "保留 Worktree 成果并结束流水线" },
            { value: "继续微调", description: "退回修复节点进一步优化", requireReason: true },
            { value: "放弃补丁", description: "不采纳并中止本次修复" },
          ],
        },
        {
          id: "done_fixed",
          kind: "end",
          label: "修复完成",
          outcome: "complete",
          reasonTemplate: "CI 修复已采纳：{{nodes.draft_autofix.value.patchSummary}}",
        },
        {
          id: "done_flaky",
          kind: "end",
          label: "Flaky 归档结束",
          outcome: "skip",
          reasonTemplate: "已归档为偶发波动：{{nodes.diagnose_ci.value.rootCause}}",
        },
        {
          id: "aborted",
          kind: "end",
          label: "已中止",
          outcome: "stop",
          reasonTemplate: "人工终止 CI 修复流程",
        },
      ],
      edges: [
        { id: "e1", from: "trigger", to: "collect_ci_state" },
        { id: "e2", from: "collect_ci_state", to: "diagnose_ci" },
        {
          id: "e3",
          from: "diagnose_ci",
          to: "flaky_notice",
          when: "nodes.diagnose_ci.value.isFlaky == true",
        },
        {
          id: "e4",
          from: "diagnose_ci",
          to: "draft_autofix",
          when: "nodes.diagnose_ci.value.isFlaky == false",
        },
        {
          id: "e5",
          from: "flaky_notice",
          to: "done_flaky",
          when: "nodes.flaky_notice.choice == '仅记录并跳过修复'",
        },
        {
          id: "e6",
          from: "flaky_notice",
          to: "aborted",
          when: "nodes.flaky_notice.choice == '停止排查'",
        },
        { id: "e7", from: "draft_autofix", to: "verify_fix" },
        {
          id: "e8",
          from: "verify_fix",
          to: "draft_autofix",
          when: "nodes.verify_fix.value.approved == false",
          isLoop: true,
        },
        {
          id: "e9",
          from: "verify_fix",
          to: "approve_patch",
          when: "nodes.verify_fix.value.approved == true",
        },
        {
          id: "e10",
          from: "approve_patch",
          to: "done_fixed",
          when: "nodes.approve_patch.choice == '采纳补丁'",
        },
        {
          id: "e11",
          from: "approve_patch",
          to: "draft_autofix",
          when: "nodes.approve_patch.choice == '继续微调'",
          isLoop: true,
        },
        {
          id: "e12",
          from: "approve_patch",
          to: "aborted",
          when: "nodes.approve_patch.choice == '放弃补丁'",
        },
      ],
    };
  }

  if (template === "docs-drift-sync") {
    return {
      schemaVersion: 1,
      name: safeName,
      version: 1,
      title: "代码与文档漂移同步",
      description:
        "配备零 Token precheck 前置检查（自动触发时先校验仓库上下文），扫描代码与文档是否脱节，无漂移直接 skip，有漂移则在隔离 Worktree 起草同步更新。",
      maxHops: 2,
      precheck: {
        command: ["git", "rev-parse", "--is-inside-work-tree"],
        cwd: ".",
        timeoutSeconds: 15,
        runOnManual: false,
      },
      bots: {
        docs_auditor: {
          label: "云舒 · 漂移侦查",
          runtimeMode: "approval-required",
          interactionMode: "plan",
          workspace: "root",
          rolePrompt: "只读核对近期代码变更与 README / docs/ 文档是否一致，精确列出失同步条目。",
          ...providerMeta,
        },
        docs_writer: {
          label: "云舒 · 文档编辑",
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
          workspace: "worktree",
          workspaceBaseRef: "HEAD",
          rolePrompt:
            "用准确、简洁、以用户任务为中心的语言更新文档，绝不虚构不存在的开关与命令行。",
          ...providerMeta,
        },
      },
      triggers: [{ kind: "manual" }],
      nodes: [
        {
          id: "scan_drift",
          kind: "agent",
          label: "扫描代码与文档漂移",
          botId: "docs_auditor",
          project,
          promptTemplate:
            "请以只读方式检查最近代码提交与公开配置是否导致文档过时：\n补充范围：{{payload.task}}",
          returns: [
            { name: "hasDrift", type: "boolean", description: "是否存在需要更新的文档漂移" },
            { name: "findings", type: "string", description: "具体漂移位置与原因" },
          ],
        },
        {
          id: "update_docs",
          kind: "agent",
          label: "隔离 Worktree 更新文档",
          botId: "docs_writer",
          project,
          promptTemplate:
            "请根据漂移清单更新对应文档并保持行文克制准确：\n发现：{{nodes.scan_drift.value.findings}}\n补充要求：{{nodes.review_docs.reason}}",
          returns: [{ name: "summary", type: "string", description: "更新文件与内容摘要" }],
        },
        {
          id: "review_docs",
          kind: "gate",
          label: "人工审阅文档改动",
          gateMode: "human",
          askKind: "docs_approval",
          titleTemplate: "云舒已完成文档更新，请审阅确认：\n{{nodes.update_docs.value.summary}}",
          choices: [
            { value: "确认更新", description: "批准文档改动并完成" },
            { value: "补充调整", description: "退回编辑节点继续完善", requireReason: true },
            { value: "暂不修改", description: "丢弃本次文档草案并结束" },
          ],
        },
        {
          id: "done",
          kind: "end",
          label: "文档已同步",
          outcome: "complete",
          reasonTemplate: "文档同步完成：{{nodes.update_docs.value.summary}}",
        },
        {
          id: "no_drift_skip",
          kind: "end",
          label: "无漂移跳过",
          outcome: "skip",
          reasonTemplate: "代码与文档保持一致，无需更新",
        },
        {
          id: "aborted",
          kind: "end",
          label: "已取消",
          outcome: "stop",
          reasonTemplate: "已取消文档更新",
        },
      ],
      edges: [
        { id: "e1", from: "trigger", to: "scan_drift" },
        {
          id: "e2",
          from: "scan_drift",
          to: "no_drift_skip",
          when: "nodes.scan_drift.value.hasDrift == false",
        },
        {
          id: "e3",
          from: "scan_drift",
          to: "update_docs",
          when: "nodes.scan_drift.value.hasDrift == true",
        },
        { id: "e4", from: "update_docs", to: "review_docs" },
        {
          id: "e5",
          from: "review_docs",
          to: "done",
          when: "nodes.review_docs.choice == '确认更新'",
        },
        {
          id: "e6",
          from: "review_docs",
          to: "update_docs",
          when: "nodes.review_docs.choice == '补充调整'",
          isLoop: true,
        },
        {
          id: "e7",
          from: "review_docs",
          to: "aborted",
          when: "nodes.review_docs.choice == '暂不修改'",
        },
      ],
    };
  }

  if (template === "release-notes-prep") {
    return {
      schemaVersion: 1,
      name: safeName,
      version: 1,
      title: "发版日志与交付把关",
      description:
        "颜汐汇总最近提交并按影响分类撰写中英文 Release Notes，林清核对准确性后由人类定稿，支持打回润色。",
      maxHops: 2,
      bots: {
        release_scribe: {
          label: "颜汐 · 日志撰写",
          runtimeMode: "approval-required",
          interactionMode: "plan",
          workspace: "root",
          rolePrompt:
            "收集区间内 Git 提交与 PR，按「破坏性变更 / 新增特性 / 问题修复 / 内部重构」输出面向上游用户的中英文发版说明。",
          ...providerMeta,
        },
        release_verifier: {
          label: "林清 · 交付核对",
          runtimeMode: "approval-required",
          interactionMode: "plan",
          workspace: "root",
          rolePrompt: "核对 Release Notes 是否遗漏重要提交、是否存在夸大表述或版本号错漏。",
          ...providerMeta,
        },
      },
      triggers: [{ kind: "manual" }],
      nodes: [
        {
          id: "collect_changes",
          kind: "agent",
          label: "汇总提交与生成草案",
          botId: "release_scribe",
          project,
          promptTemplate:
            "请生成结构化发版日志草案（只读调研，不改动生产文件）。\n目标版本/范围：{{payload.task}}\n核对意见（若有）：{{nodes.audit_release_notes.value.gaps}}\n人工润色要求（若有）：{{nodes.approve_release_notes.reason}}",
          returns: [
            { name: "draft", type: "string", description: "中英文 Release Notes 草案" },
            { name: "highlights", type: "string", description: "核心亮点摘要" },
          ],
        },
        {
          id: "audit_release_notes",
          kind: "agent",
          label: "核对真实性与完整性",
          botId: "release_verifier",
          project,
          promptTemplate:
            "请对照仓库最近提交核对以下发版日志草案是否真实完整：\n{{nodes.collect_changes.value.draft}}",
          returns: [
            { name: "ready", type: "boolean", description: "草案是否准确完备" },
            { name: "gaps", type: "string", description: "发现的遗漏或修正意见" },
          ],
        },
        {
          id: "approve_release_notes",
          kind: "gate",
          label: "人工定稿确认",
          gateMode: "human",
          askKind: "release_notes_approval",
          titleTemplate: "Release Notes 复核已通过，是否定稿？",
          choices: [
            { value: "定稿发布", description: "确认发版说明可直接使用" },
            { value: "继续润色", description: "退回颜汐按补充意见修改", requireReason: true },
            { value: "取消", description: "终止本次整理" },
          ],
        },
        {
          id: "done",
          kind: "end",
          label: "发版日志已定稿",
          outcome: "complete",
          reasonTemplate: "亮点摘要：{{nodes.collect_changes.value.highlights}}",
        },
        {
          id: "aborted",
          kind: "end",
          label: "已取消",
          outcome: "stop",
          reasonTemplate: "已取消发版说明整理",
        },
      ],
      edges: [
        { id: "e1", from: "trigger", to: "collect_changes" },
        { id: "e2", from: "collect_changes", to: "audit_release_notes" },
        {
          id: "e3",
          from: "audit_release_notes",
          to: "collect_changes",
          when: "nodes.audit_release_notes.value.ready == false",
          isLoop: true,
        },
        {
          id: "e4",
          from: "audit_release_notes",
          to: "approve_release_notes",
          when: "nodes.audit_release_notes.value.ready == true",
        },
        {
          id: "e5",
          from: "approve_release_notes",
          to: "done",
          when: "nodes.approve_release_notes.choice == '定稿发布'",
        },
        {
          id: "e6",
          from: "approve_release_notes",
          to: "collect_changes",
          when: "nodes.approve_release_notes.choice == '继续润色'",
          isLoop: true,
        },
        {
          id: "e7",
          from: "approve_release_notes",
          to: "aborted",
          when: "nodes.approve_release_notes.choice == '取消'",
        },
      ],
    };
  }

  if (template === "daily-repo-standup") {
    return {
      schemaVersion: 1,
      name: safeName,
      version: 1,
      title: "每日进展与仓库巡检",
      description:
        "只读汇总近 24 小时提交、活跃工作分支与遗留阻塞，输出简洁晨会简报。可按需在「触发与安全」里添加 daily 定时（例如每天 09:30）。",
      maxHops: 2,
      bots: {
        standup_host: {
          label: "许晨 · 站会主机",
          runtimeMode: "approval-required",
          interactionMode: "plan",
          workspace: "root",
          rolePrompt:
            "只读扫描最近 24 小时提交、未提交工作区改动及开放任务，输出精炼、不啰嗦的站会汇报。",
          ...providerMeta,
        },
      },
      triggers: [{ kind: "manual" }],
      nodes: [
        {
          id: "gather_digest",
          kind: "agent",
          label: "生成每日研发简报",
          botId: "standup_host",
          project,
          promptTemplate:
            "请以只读方式生成今天的项目研发站会简报（含：昨日交付、今日建议优先项、风险与阻塞）。\n额外关注（若有）：{{payload.task}}",
          returns: [
            { name: "digest", type: "string", description: "结构化每日站会简报" },
            { name: "blockers", type: "string", description: "需要人工关注的阻塞或待确认项" },
          ],
        },
        {
          id: "done",
          kind: "end",
          label: "简报完成",
          outcome: "complete",
          reasonTemplate: "每日站会简报已就绪：{{nodes.gather_digest.value.blockers}}",
        },
      ],
      edges: [
        { id: "e1", from: "trigger", to: "gather_digest" },
        { id: "e2", from: "gather_digest", to: "done" },
      ],
    };
  }

  if (template === "issue-triage") {
    return {
      schemaVersion: 1,
      name: safeName,
      version: 1,
      title: "Issue 智能分诊与转修",
      description:
        "参考 GitHub gh-aw 分诊范式：只读完成问题分类与影响定级，再经人类决定是仅输出分诊答复、立即派工 Worktree 修复，还是暂缓。",
      maxHops: 2,
      bots: {
        triager: {
          label: "苏探 · 分诊官",
          runtimeMode: "approval-required",
          interactionMode: "plan",
          workspace: "root",
          rolePrompt:
            "严谨识别 Issue 属于 bug / feature / docs / question，核对缺失信息并定位可能关联代码模块。",
          ...providerMeta,
        },
        fixer: {
          label: "苏探 · 隔离修复 Worker",
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
          workspace: "worktree",
          workspaceBaseRef: "HEAD",
          rolePrompt: "在独立 Worktree 内完成最小闭环修复并验证关联单测。",
          ...providerMeta,
        },
      },
      triggers: [{ kind: "manual" }],
      nodes: [
        {
          id: "classify_issue",
          kind: "agent",
          label: "分类定级与定位",
          botId: "triager",
          project,
          promptTemplate:
            "请对以下 Issue 或问题反馈执行只读分诊分析（分类标签、严重度、关联文件及草拟回复）：\n{{payload.task}}",
          returns: [
            {
              name: "category",
              type: "string",
              description: "bug / enhancement / docs / question",
            },
            { name: "severity", type: "string", description: "P0 / P1 / P2" },
            { name: "summary", type: "string", description: "分诊总结与复现定位" },
          ],
        },
        {
          id: "triage_decision",
          kind: "gate",
          label: "分诊去向拍板",
          gateMode: "human",
          askKind: "issue_triage_decision",
          titleTemplate:
            "分诊结果 [{{nodes.classify_issue.value.category}} · {{nodes.classify_issue.value.severity}}]：是否立即派工修复？",
          choices: [
            { value: "派工隔离修复", description: "在隔离 Worktree 自动实现修复" },
            { value: "仅输出分诊回复", description: "保留分类结果与建议回复并结束" },
            { value: "暂缓归档", description: "延后处理" },
          ],
        },
        {
          id: "fix_issue",
          kind: "agent",
          label: "隔离 Worktree 修复",
          botId: "fixer",
          project,
          promptTemplate:
            "已获准修复 Issue，请根据分诊定位实现最小修改与测试：\n分类：{{nodes.classify_issue.value.category}}\n分析：{{nodes.classify_issue.value.summary}}\n人工补充：{{nodes.triage_decision.reason}}",
          returns: [{ name: "fixSummary", type: "string", description: "修复与测试结果" }],
        },
        {
          id: "done_fixed",
          kind: "end",
          label: "修复交付",
          outcome: "complete",
          reasonTemplate: "分诊后已修复：{{nodes.fix_issue.value.fixSummary}}",
        },
        {
          id: "done_triaged",
          kind: "end",
          label: "分诊完成",
          outcome: "complete",
          reasonTemplate: "完成分诊：{{nodes.classify_issue.value.summary}}",
        },
        {
          id: "done_deferred",
          kind: "end",
          label: "暂缓处理",
          outcome: "skip",
          reasonTemplate: "Issue 暂缓归档：{{nodes.triage_decision.reason}}",
        },
      ],
      edges: [
        { id: "e1", from: "trigger", to: "classify_issue" },
        { id: "e2", from: "classify_issue", to: "triage_decision" },
        {
          id: "e3",
          from: "triage_decision",
          to: "fix_issue",
          when: "nodes.triage_decision.choice == '派工隔离修复'",
        },
        {
          id: "e4",
          from: "triage_decision",
          to: "done_triaged",
          when: "nodes.triage_decision.choice == '仅输出分诊回复'",
        },
        {
          id: "e5",
          from: "triage_decision",
          to: "done_deferred",
          when: "nodes.triage_decision.choice == '暂缓归档'",
        },
        { id: "e6", from: "fix_issue", to: "done_fixed" },
      ],
    };
  }

  if (template === "feature-plan-ship") {
    return {
      schemaVersion: 1,
      name: safeName,
      version: 1,
      title: "Plan 先行与安全网交付",
      description:
        "严格遵循 Plan Mode 先行黄金法则：只读制定方案 -> 人类拍板批准 -> 隔离 Worktree 全权实现 -> 林清复核闭环。",
      maxHops: 2,
      bots: {
        planner: {
          label: "月谣 · 方案架构",
          runtimeMode: "approval-required",
          interactionMode: "plan",
          workspace: "root",
          rolePrompt: "充分调研现有架构与可复用工具，输出简洁、分步骤、包含验证方式的实施方案。",
          ...providerMeta,
        },
        executor: {
          label: "苏探 · 全权实现",
          runtimeMode: "full-access",
          interactionMode: "default",
          workspace: "worktree",
          workspaceBaseRef: "HEAD",
          rolePrompt: "严格按批准的方案实施改动并跑通相关单测与类型检查。",
          ...providerMeta,
        },
        reviewer: {
          label: "林清 · 验收评审",
          runtimeMode: "approval-required",
          interactionMode: "plan",
          workspace: "root",
          rolePrompt: "对照方案验收实现质量、风格一致性与回归安全网。",
          ...providerMeta,
        },
      },
      triggers: [{ kind: "manual" }],
      nodes: [
        {
          id: "plan",
          kind: "agent",
          label: "Plan 只读设计方案",
          botId: "planner",
          project,
          promptTemplate:
            "请先调研代码现状并产出清晰实施方案（含文件影响面与验证步骤）：\n需求：{{payload.task}}\n打回意见（若有）：{{nodes.approve_plan.reason}}",
          returns: [{ name: "summary", type: "string", description: "实施方案摘要" }],
        },
        {
          id: "approve_plan",
          kind: "gate",
          label: "方案批准门",
          gateMode: "human",
          askKind: "plan_approval",
          titleTemplate: "实施方案已就绪，批准后才开始写代码：",
          choices: [
            { value: "批准执行", description: "授权 Worktree 隔离落地代码" },
            { value: "打回重做", description: "退回方案设计修改", requireReason: true },
            { value: "取消中止", description: "终止本次需求" },
          ],
        },
        {
          id: "execute",
          kind: "agent",
          label: "隔离 Worktree 落地",
          botId: "executor",
          project,
          promptTemplate:
            "方案已获批准，请在隔离 Worktree 中实施改动并跑通测试：\n方案摘要：{{nodes.plan.value.summary}}\n人工备注：{{nodes.approve_plan.reason}}\n评审返工意见（若有）：{{nodes.verify_ship.value.notes}}",
          returns: [{ name: "delivery", type: "string", description: "改动文件与测试验证结论" }],
        },
        {
          id: "verify_ship",
          kind: "agent",
          label: "林清验收闭环",
          botId: "reviewer",
          project,
          promptTemplate:
            "请对照设计方案核验交付成果是否干净达标：\n方案：{{nodes.plan.value.summary}}\n交付：{{nodes.execute.value.delivery}}",
          returns: [
            { name: "approved", type: "boolean", description: "是否通过最终验收" },
            { name: "notes", type: "string", description: "验收评语或需修正问题" },
          ],
        },
        {
          id: "done",
          kind: "end",
          label: "验收完成",
          outcome: "complete",
          reasonTemplate: "交付完成：{{nodes.execute.value.delivery}}",
        },
        {
          id: "aborted",
          kind: "end",
          label: "已中止",
          outcome: "stop",
          reasonTemplate: "方案未批准，人工取消：{{nodes.approve_plan.reason}}",
        },
      ],
      edges: [
        { id: "e1", from: "trigger", to: "plan" },
        { id: "e2", from: "plan", to: "approve_plan" },
        {
          id: "e3",
          from: "approve_plan",
          to: "execute",
          when: "nodes.approve_plan.choice == '批准执行'",
        },
        {
          id: "e4",
          from: "approve_plan",
          to: "plan",
          when: "nodes.approve_plan.choice == '打回重做'",
          isLoop: true,
        },
        {
          id: "e5",
          from: "approve_plan",
          to: "aborted",
          when: "nodes.approve_plan.choice == '取消中止'",
        },
        { id: "e6", from: "execute", to: "verify_ship" },
        {
          id: "e7",
          from: "verify_ship",
          to: "execute",
          when: "nodes.verify_ship.value.approved == false",
          isLoop: true,
        },
        {
          id: "e8",
          from: "verify_ship",
          to: "done",
          when: "nodes.verify_ship.value.approved == true",
        },
      ],
    };
  }

  // Default: "bug-repro-fix"
  return {
    schemaVersion: 1,
    name: safeName,
    version: 1,
    title: "Bug 复现与并行修复",
    description:
      "苏探先只读分诊定位，再派两个隔离 Worktree Bot 并行编写复现单测与实施最小修复，经林清闭环复核（含熔断）后由人类拍板发布。",
    maxHops: 2,
    bots: {
      scout: {
        label: "苏探 · 分诊定位",
        runtimeMode: "approval-required",
        interactionMode: "plan",
        workspace: "root",
        rolePrompt: "先只读复盘报错症状并定位根因范围，拆分复现测试要点与最小修复方向。",
        ...providerMeta,
      },
      reproducer: {
        label: "夏哨 · 复现测试",
        runtimeMode: "auto-accept-edits",
        interactionMode: "default",
        workspace: "worktree",
        workspaceBaseRef: "HEAD",
        rolePrompt: "在隔离 Worktree 编写先失败后通过的最小复现回归测试。",
        ...providerMeta,
      },
      fixer: {
        label: "苏探 · 隔离修复",
        runtimeMode: "auto-accept-edits",
        interactionMode: "default",
        workspace: "worktree",
        workspaceBaseRef: "HEAD",
        rolePrompt: "在隔离 Worktree 实施精准最小根因修复，确保构建与单测通过。",
        ...providerMeta,
      },
      reviewer: {
        label: "林清 · 联合评审",
        runtimeMode: "approval-required",
        interactionMode: "plan",
        workspace: "root",
        rolePrompt: "核验复现测试有效性、修复安全性及是否存在副作用。",
        ...providerMeta,
      },
    },
    triggers: [{ kind: "manual" }],
    nodes: [
      {
        id: "triage",
        kind: "agent",
        label: "根因分诊与拆解",
        botId: "scout",
        project,
        promptTemplate: "请先只读调研问题症状与相关模块并拆分复现与修复目标：\n{{payload.task}}",
        returns: [
          { name: "reproPlan", type: "string", description: "最小复现测试思路" },
          { name: "rootCauseHint", type: "string", description: "根因定位与修复方向" },
        ],
      },
      {
        id: "write_repro",
        kind: "agent",
        label: "并行编写复现单测",
        botId: "reproducer",
        project,
        promptTemplate:
          "请在隔离 Worktree 编写精准覆盖该问题的复现单测：\n{{nodes.triage.value.reproPlan}}",
        returns: [{ name: "checks", type: "string", description: "复现测试与断言说明" }],
      },
      {
        id: "apply_fix",
        kind: "agent",
        label: "并行实施最小修复",
        botId: "fixer",
        project,
        promptTemplate:
          "请在隔离 Worktree 实施精准修复：\n定位线索：{{nodes.triage.value.rootCauseHint}}\n评审意见（若有）：{{nodes.review_fix.value.notes}}\n人工备注（若有）：{{nodes.approve_merge.reason}}",
        returns: [{ name: "summary", type: "string", description: "修复改动与局部验证说明" }],
      },
      {
        id: "review_fix",
        kind: "agent",
        label: "林清联合回归评审",
        botId: "reviewer",
        project,
        promptTemplate:
          "请评审修复改动与复现测试覆盖情况：\n[修复实现] {{nodes.apply_fix.value.summary}}\n[复现单测] {{nodes.write_repro.value.checks}}",
        returns: [
          { name: "approved", type: "boolean", description: "是否通过评审" },
          { name: "notes", type: "string", description: "评审意见或返工原因" },
        ],
      },
      {
        id: "approve_merge",
        kind: "gate",
        label: "人工发布审批",
        gateMode: "coordinator_then_human",
        askKind: "ship_approval",
        titleTemplate: "复现测试与修复评审均已通过，是否采纳并交付？",
        choices: [
          { value: "批准采纳", description: "完成本次修复流水线" },
          { value: "继续修改", description: "打回给修复节点微调", requireReason: true },
          { value: "取消中止", description: "终止本次流程" },
        ],
      },
      {
        id: "done",
        kind: "end",
        label: "修复交付完成",
        outcome: "complete",
        reasonTemplate: "复现测试与修复评审均已通过：{{nodes.apply_fix.value.summary}}",
      },
      {
        id: "aborted",
        kind: "end",
        label: "已中止",
        outcome: "stop",
        reasonTemplate: "人工终止：{{nodes.approve_merge.reason}}",
      },
    ],
    edges: [
      { id: "e1", from: "trigger", to: "triage" },
      { id: "e2", from: "triage", to: "write_repro" },
      { id: "e3", from: "triage", to: "apply_fix" },
      { id: "e4", from: "write_repro", to: "review_fix" },
      { id: "e5", from: "apply_fix", to: "review_fix" },
      {
        id: "e6",
        from: "review_fix",
        to: "approve_merge",
        when: "nodes.review_fix.value.approved == true",
      },
      {
        id: "e7",
        from: "review_fix",
        to: "apply_fix",
        when: "nodes.review_fix.value.approved == false",
        isLoop: true,
      },
      {
        id: "e8",
        from: "approve_merge",
        to: "done",
        when: "nodes.approve_merge.choice == '批准采纳'",
      },
      {
        id: "e9",
        from: "approve_merge",
        to: "apply_fix",
        when: "nodes.approve_merge.choice == '继续修改'",
        isLoop: true,
      },
      {
        id: "e10",
        from: "approve_merge",
        to: "aborted",
        when: "nodes.approve_merge.choice == '取消中止'",
      },
    ],
  };
}
