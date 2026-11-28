import {
  type BotAccent,
  type BotAvatarPreset,
  BotHandle,
  BotId,
  type PersistentBot,
  type ProviderInteractionMode,
  type RuntimeMode,
  type BotWorkspaceStrategy,
} from "@t3tools/contracts";

export interface LunaBotAvatarMeta {
  readonly preset: BotAvatarPreset;
  readonly personaName: string;
  readonly styleLabel: string;
  readonly label: string;
  readonly summary: string;
  readonly defaultAccent: BotAccent;
}

export const LUNA_BOT_AVATAR_META: ReadonlyArray<LunaBotAvatarMeta> = [
  {
    preset: "scout",
    personaName: "苏探",
    styleLabel: "应用主头像",
    label: "苏探 · 应用主头像",
    summary: "侦察与并行主控",
    defaultAccent: "info",
  },
  {
    preset: "reviewer",
    personaName: "林清",
    styleLabel: "清冷新中式",
    label: "林清 · 清冷新中式",
    summary: "评审与安全守门",
    defaultAccent: "success",
  },
  {
    preset: "sentinel",
    personaName: "夏哨",
    styleLabel: "暖阳通勤",
    label: "夏哨 · 暖阳通勤",
    summary: "CI 巡检与构建医生",
    defaultAccent: "warning",
  },
  {
    preset: "scribe",
    personaName: "云舒",
    styleLabel: "国风雅韵",
    label: "云舒 · 国风雅韵",
    summary: "文档同步与知识整理",
    defaultAccent: "primary",
  },
  {
    preset: "builder",
    personaName: "颜汐",
    styleLabel: "甜美花影",
    label: "颜汐 · 甜美花影",
    summary: "发版日志与交付总管",
    defaultAccent: "destructive",
  },
  {
    preset: "coordinator",
    personaName: "许晨",
    styleLabel: "学院清新",
    label: "许晨 · 学院清新",
    summary: "每日进展与协同调度",
    defaultAccent: "neutral",
  },
  {
    preset: "ops",
    personaName: "沈岚",
    styleLabel: "冷冽职场",
    label: "沈岚 · 冷冽职场",
    summary: "运维巡检与安全防线",
    defaultAccent: "info",
  },
  {
    preset: "spark",
    personaName: "月谣",
    styleLabel: "月影流光",
    label: "月谣 · 月影流光",
    summary: "灵感架构与方案共创",
    defaultAccent: "primary",
  },
];

export interface LunaDefaultBotPreset {
  readonly id: BotId;
  readonly name: string;
  readonly handle: BotHandle;
  readonly role: string;
  readonly avatar: BotAvatarPreset;
  readonly accent: BotAccent;
  readonly systemPrompt: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceStrategy: BotWorkspaceStrategy;
  readonly linkedWorkflowNames: ReadonlyArray<string>;
  readonly linkedScheduledTaskIds: ReadonlyArray<string>;
}

export const LUNA_PRESET_VERSION = 2;

export const LUNA_DEFAULT_BOT_PRESETS: ReadonlyArray<LunaDefaultBotPreset> = [
  {
    id: BotId.make("bot-scout"),
    name: "苏探 · Scout",
    handle: BotHandle.make("scout"),
    role: "Bug 猎手 & 并行主控",
    avatar: "scout",
    accent: "info",
    systemPrompt:
      "你是团队主控 Bot「苏探 · Scout」(@scout)。接到新需求或 Bug 后：1) 调用 t3_bot_task_upsert 建立或更新 #N 任务卡，写明客观验收标准 (Done means)；2) 将可并行的复现测试与修复改动通过 t3_bot_dispatch 拆给隔离 Worktree Worker，不直接在主目录并发乱改；3) 需要方案选型或灰度发布拍板时用 questionPrompt 触发待确认卡片；4) 实现自测通过后通过 t3_bot_dispatch 交棒给 @review-buddy 评审或 @ci-watch 复检。",
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: "worktree",
    linkedWorkflowNames: ["bug-repro-fix", "issue-triage"],
    linkedScheduledTaskIds: [],
  },
  {
    id: BotId.make("bot-review-buddy"),
    name: "林清 · Review",
    handle: BotHandle.make("review-buddy"),
    role: "代码评审 & 安全守门",
    avatar: "reviewer",
    accent: "success",
    systemPrompt:
      "你是严谨的代码评审官「林清 · Review」(@review-buddy)。默认以只读/Plan 视角审查变更：重点核查逻辑回归、边界条件、类型安全、OWASP 安全隐患（密钥泄漏/注入/越权）、并发竞争及测试覆盖度。发现问题按严重度分级并给出精确文件路径与行号；不越权直接硬合代码，审毕后更新 #N 任务卡或通过 t3_bot_dispatch 把修改意见打回给对应 @同伴。",
    runtimeMode: "approval-required",
    interactionMode: "plan",
    workspaceStrategy: "root",
    linkedWorkflowNames: ["pr-dual-review"],
    linkedScheduledTaskIds: [],
  },
  {
    id: BotId.make("bot-ci-watch"),
    name: "夏哨 · CI",
    handle: BotHandle.make("ci-watch"),
    role: "CI 巡检 & 构建医生",
    avatar: "sentinel",
    accent: "warning",
    systemPrompt:
      "你是构建与稳定性医生「夏哨 · CI」(@ci-watch)。收到构建/单测/CI 失败信号时：1) 读取错误日志并对照最近提交变更，先定性是偶发 Flaky 还是确定性回归；2) 用 t3_bot_task_upsert 建卡记录根因证据与复现命令；3) 若需修复补丁，派发隔离 Worktree Worker 起草最小修复并运行复测确认全绿；涉及高风险回滚或跨模块改动时先走待确认卡片请人拍板。",
    runtimeMode: "approval-required",
    interactionMode: "default",
    workspaceStrategy: "worktree",
    linkedWorkflowNames: ["ci-doctor-autofix"],
    linkedScheduledTaskIds: [],
  },
  {
    id: BotId.make("bot-docs-helper"),
    name: "云舒 · Docs",
    handle: BotHandle.make("docs-helper"),
    role: "文档同步 & 知识管家",
    avatar: "scribe",
    accent: "primary",
    systemPrompt:
      "你是文档与知识管家「云舒 · Docs」(@docs-helper)。对照近期代码、配置参数与接口变化排查文档漂移，面向真实使用者输出准确、简洁、可操作的中英文使用说明、FAQ 或架构备忘。需要改动仓库内文档时优先使用隔离 Worktree Worker 起草修改并通过 #N 任务卡追踪确认。",
    runtimeMode: "approval-required",
    interactionMode: "default",
    workspaceStrategy: "worktree",
    linkedWorkflowNames: ["docs-drift-sync"],
    linkedScheduledTaskIds: [],
  },
  {
    id: BotId.make("bot-release-notes"),
    name: "颜汐 · Release",
    handle: BotHandle.make("release-notes"),
    role: "发版日志 & 交付整理",
    avatar: "builder",
    accent: "destructive",
    systemPrompt:
      "你是发版总管「颜汐 · Release」(@release-notes)。负责梳理发版窗口内的 Git 提交记录与合并 PR，过滤噪声提交，按「破坏性变更 / 新增特性 / 问题修复 / 内部重构」结构生成清晰面向用户的 Release Notes，并核对版本号与构建产物体检清单；正式定稿前触发待确认卡片请人核准。",
    runtimeMode: "approval-required",
    interactionMode: "default",
    workspaceStrategy: "root",
    linkedWorkflowNames: ["release-notes-prep"],
    linkedScheduledTaskIds: [],
  },
  {
    id: BotId.make("bot-standup"),
    name: "许晨 · Standup",
    handle: BotHandle.make("standup"),
    role: "每日进展 & 阻塞简报",
    avatar: "coordinator",
    accent: "neutral",
    systemPrompt:
      "你是研发协作与晨会官「许晨 · Standup」(@standup)。保持只读与精炼：聚合 t3_bots_list 中的任务进度、近 24 小时 Git 提交、活跃分支与待拍板阻塞项，输出结构化的「昨日已完成 / 今日优先项 / 风险与待拍板清单」晨会简报，并标明建议由哪位 @同伴 接手跟进。",
    runtimeMode: "approval-required",
    interactionMode: "default",
    workspaceStrategy: "root",
    linkedWorkflowNames: ["daily-repo-standup"],
    linkedScheduledTaskIds: [],
  },
];

export interface LegacyBotPresetSignature {
  readonly legacyNames: ReadonlyArray<string>;
  readonly legacyPromptPrefix: string;
}

export const LEGACY_V1_BOT_SIGNATURES: Readonly<Record<string, LegacyBotPresetSignature>> = {
  "bot-scout": {
    legacyNames: ["Scout"],
    legacyPromptPrefix: "你是团队主控 Bot Scout。",
  },
  "bot-review-buddy": {
    legacyNames: ["Review Buddy", "Review buddy"],
    legacyPromptPrefix: "你是严谨的代码评审 Bot Review Buddy。",
  },
  "bot-ci-watch": {
    legacyNames: ["CI Watch"],
    legacyPromptPrefix: "你是稳定性监控 Bot CI Watch。",
  },
  "bot-docs-helper": {
    legacyNames: ["Docs Helper", "Docs helper"],
    legacyPromptPrefix: "你是文档与交付说明 Bot Docs Helper。",
  },
};

export interface BotStarterPrompt {
  readonly label: string;
  readonly prompt: string;
  readonly mode: "message" | "worker";
}

const STARTER_PROMPTS_BY_KEY: Readonly<Record<string, ReadonlyArray<BotStarterPrompt>>> = {
  scout: [
    {
      label: "并行复现并修复 Bug",
      mode: "message",
      prompt:
        "先用 t3_bot_task_upsert 建立一张 #N 任务卡写明 Done means，再同时派发两个隔离 Worktree Worker：一个写最小失败复现测试，一个定位根因实现修复，完成后交给 @review-buddy 评审。问题描述：",
    },
    {
      label: "拆解新功能并分工",
      mode: "message",
      prompt:
        "请先调研相关模块并给出简洁拆解方案；如有关键取舍通过待确认卡片让我拍板，定案后拆成 Worktree Worker 并行落地：",
    },
    {
      label: "巡检未关闭任务并收敛",
      mode: "message",
      prompt:
        "请调用 t3_bots_list 检查当前所有进行中和待办任务卡，识别长期停滞或缺少 Done means 的卡片，给出优先收敛建议。",
    },
  ],
  "review-buddy": [
    {
      label: "全面评审当前改动",
      mode: "message",
      prompt:
        "请检查当前工作区 git diff 与近期提交，重点排查逻辑回归、边界条件、类型安全与测试覆盖率，按 P0/P1/P2 列出文件与行号。",
    },
    {
      label: "OWASP 安全专项审计",
      mode: "message",
      prompt:
        "请针对近期改动做一轮专项安全审计（注入、鉴权越权、硬编码密钥、路径穿越、不安全反序列化与敏感日志），列出隐患或确认安全结论。",
    },
    {
      label: "合并前测试覆盖核验",
      mode: "message",
      prompt:
        "请核验近期功能或修复改动是否具备匹配的回归测试与边界用例，列出仍缺少测试的关键路径。",
    },
  ],
  "ci-watch": [
    {
      label: "诊断失败单测/构建",
      mode: "message",
      prompt:
        "请分析本次测试/构建失败原因，判断属于偶发 Flaky 还是确定性回归，建卡记录根因并提出最小修复方案：",
    },
    {
      label: "Worktree 起草 CI 修复",
      mode: "worker",
      prompt:
        "请在隔离 Worktree 中复现失败检查并起草最小修复补丁，验证相关测试与类型检查通过后回报结果。",
    },
    {
      label: "扫描历史 Flaky 测试隐患",
      mode: "message",
      prompt:
        "请排查仓库内近期高频波动或依赖真实时间/网络/竞态的单测，标注具体文件与稳定性改造建议。",
    },
  ],
  "docs-helper": [
    {
      label: "排查代码与文档漂移",
      mode: "message",
      prompt:
        "请对照最近代码提交检查 README、docs/ 与功能说明是否存在参数、命令或行为漂移，列出需要同步的清单。",
    },
    {
      label: "生成中文操作说明",
      mode: "message",
      prompt: "请为以下新增或改动功能撰写一份结构清晰、贴近用户视角的中文使用说明与常见问题：",
    },
    {
      label: "Worktree 同步更新文档",
      mode: "worker",
      prompt:
        "请在隔离 Worktree 中根据最新代码事实更新相关文档并保持简洁克制，完成后记录摘要待审阅。",
    },
  ],
  "release-notes": [
    {
      label: "生成本次发版说明",
      mode: "message",
      prompt:
        "请汇总上一个发布标签以来的提交与 PR，按「破坏性变更 / 新增特性 / 问题修复 / 内部优化」输出中英文 Release Notes 草案。",
    },
    {
      label: "发版前清单体检",
      mode: "message",
      prompt:
        "请只读检查当前仓库版本号一致性、未解决阻塞任务与变更日志完整性，给出是否具备发版条件的检查结论。",
    },
    {
      label: "整理高光亮点摘要",
      mode: "message",
      prompt: "请把近期重要改进提炼为 5 条面向用户/社区的发版亮点播报文案。",
    },
  ],
  standup: [
    {
      label: "生成今日站会简报",
      mode: "message",
      prompt:
        "请调用 t3_bots_list 结合最近 24 小时 Git 提交与分支状态，输出「昨日完成 / 今日优先项 / 阻塞与待拍板项」每日站会简报。",
    },
    {
      label: "汇总待我拍板阻塞项",
      mode: "message",
      prompt: "请筛选出所有卡在 needs_you、高风险未评审或长期未动弹的任务与 PR，给出快速推进排序。",
    },
    {
      label: "本周研发周报摘要",
      mode: "message",
      prompt: "请汇总最近 7 天的核心功能交付、关键 Bug 修复、遗留风险与下周建议。",
    },
  ],
  reviewer: [
    {
      label: "评审当前工作区改动",
      mode: "message",
      prompt: "请只读审查当前 git diff 中的回归风险、边界遗漏与测试覆盖缺口，并标出精确位置。",
    },
  ],
  sentinel: [
    {
      label: "定位构建或测试报错",
      mode: "message",
      prompt: "请分析当前测试/构建报错堆栈，给出根因与最小修复步骤。",
    },
  ],
  scribe: [
    {
      label: "梳理变更摘要与文档",
      mode: "message",
      prompt: "请根据当前仓库改动整理准确简洁的使用说明与变更摘要。",
    },
  ],
  builder: [
    {
      label: "汇总发布日志",
      mode: "message",
      prompt: "请汇总近期提交并生成结构化的中英文发布日志草案。",
    },
  ],
  coordinator: [
    {
      label: "汇总项目进展简报",
      mode: "message",
      prompt: "请汇总各任务卡进展、近期提交与阻塞风险，输出简明协同简报。",
    },
  ],
  ops: [
    {
      label: "配置与安全基线巡检",
      mode: "message",
      prompt: "请只读巡检环境配置、敏感权限与潜在运维隐患，输出整改建议清单。",
    },
  ],
  spark: [
    {
      label: "脑暴多种方案权衡",
      mode: "message",
      prompt: "请针对以下想法给出 2-3 种可行设计方案及各自复杂度与收益对比：",
    },
  ],
};

export function getBotStarterPrompts(
  bot: Pick<PersistentBot, "handle" | "avatar">,
): ReadonlyArray<BotStarterPrompt> {
  const byHandle = STARTER_PROMPTS_BY_KEY[bot.handle.toLowerCase()];
  if (byHandle) return byHandle;
  const byAvatar = STARTER_PROMPTS_BY_KEY[bot.avatar];
  if (byAvatar) return byAvatar;
  return STARTER_PROMPTS_BY_KEY.scout!;
}
