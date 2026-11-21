# LunaCode Fork — 二开分支与上游合并规范

本文件沉淀 `nidao003/lunacode`（基于 `pingdotgg/t3code`）的长期定制开发规范、定期合并上游 SOP、冲突裁决原则与二开台账。任何在本仓库工作的开发者与 AI Agent 均须遵守；当与上游 `AGENTS.md` 的流程或默认分支假设冲突时，以本文件为准。

---

## 1. 分支拓扑与铁律

- **远端定义**
  - `upstream`：`https://github.com/pingdotgg/t3code.git`（上游原仓，只读）
  - `origin`：`https://github.com/nidao003/lunacode.git`（本 Fork 仓库）
- **`main`（只读上游镜像分支）**
  - 由 `.github/workflows/sync-upstream.yml` 每 6 小时自动拉取并合入 `upstream/main`。
  - **严禁在 `main` 分支开发、提交定制代码或直接推送**（仅当专门维护 `sync-upstream.yml` 时例外）。
- **`lunacode`（长期定制二开主干）**
  - 所有二开功能、优化与适配统一在本分支集成与演进。
- **特性子分支与 Worktree**
  - 独立功能或较大改造可从 `lunacode` 切出子分支（建议命名：`lunacode/<topic>`），完成后合回 `lunacode`，**绝不合入 `main`**。
  - 使用 `git worktree add` 或 T3 Code 的 `t3_worktree_handoff` / `t3_thread_launch` 时，**必须显式指定 `lunacode`（或 `origin/lunacode`）作为 base**，避免误基于 `origin/main` 导致丢失全部二开改动。
- **开发前自检**
  - 动手修改任何代码前先执行 `git branch --show-current`。若当前位于 `main`，**立即中止修改并切换回 `lunacode`**（或从 `lunacode` 切出特性分支）。

---

## 2. 定期合并上游标准流程（Upstream Merge SOP）

- **合并策略**：始终在 `lunacode` 上使用 **`git merge --no-ff origin/main`**。
  - **不要 `rebase`**、**不要 `squash`**：避免改写已推送分支历史，并保留清晰的合并父提交，使 Git 三方合并基点随每次同步持续前移，避免重复解决历史冲突。

### 标准操作步骤

1. **检查工作区与当前分支**
   - 确认当前处于 `lunacode`（或基于 `lunacode` 切出的临时合并分支 `sync/upstream-YYYYMMDD`），且工作区无未保存改动（本地未跟踪配置如 `.agents/skills.json` 除外）。
2. **拉取最新镜像主干**
   - 执行 `git fetch origin main`（如需确认是否为上游最新状态，可先查看 GitHub Actions `Upstream Sync` 最近一次同步结果）。
3. **评估上游变更面**
   - 运行 `git log --oneline HEAD..origin/main` 与 `git diff --stat HEAD...origin/main`。
   - 对照第 5 节《二开定制清单》，提前识别可能与二开模块产生字面冲突或语义重叠的改动。
4. **执行合并**
   - 运行 `git merge --no-ff origin/main`。
5. **处理冲突与更新依赖**
   - 按第 3 节《冲突排查与功能裁决规则》处理所有字面冲突，并排查“无 Git 冲突但功能重叠”的上游新特性。
   - 若 `package.json`、`pnpm-lock.yaml` 或 `pnpm-workspace.yaml` 有更新，运行 `vp i` 同步依赖与锁文件。
6. **更新台账**
   - 若某项二开功能因被上游原生能力替代而下线，或接入点发生变化，在同一合并流程中更新第 5 节《二开定制清单》。
7. **校验与回归**
   - 运行 `vp run check:changed origin/main`，并根据受影响范围运行定向单测 `vp test run <files>` 与 `vp run typecheck`，确认上游新特性与二开功能均正常工作。
8. **提交并推送**
   - 提交合并（建议信息：`chore(sync): merge upstream main (YYYY-MM-DD)`），经用户确认后推送至 `origin/lunacode`。

---

## 3. 冲突排查与功能裁决规则

### 核心总纲：上游优先，差异留精

- 只要上游原生实现已能满足需求、且质量与体验相当，**优先采纳上游方案并下线重复的自研代码**，把长期维护负担压到最低。
- 仅当上游缺失关键能力、体验明显不如自研、或产品方向不符合二开目标时，才**保留并适配自研方案**。

### A. 可直接按规则裁决（合并后在汇报中写明即可）

- **非定制区的上游变更**（CI workflow、上游 docs、未定制的 provider/页面/测试等）：直接采用上游（`theirs`）。
- **锁文件（`pnpm-lock.yaml`）**：先取上游版本（`git checkout --theirs pnpm-lock.yaml`），再运行 `vp i` 重新生成，禁止手工拼接锁文件。
- **`AGENTS.md` 与 `CLAUDE.md`**：
  - `AGENTS.md`：保留顶部 LunaCode 锚点提示块，第 1 行锚点以下的 `# T3 Code` 正文全量采用上游（`theirs`）。
  - `CLAUDE.md`：保持 `@AGENTS.fork.md` 在 `@AGENTS.md` 之上的双行引用。
- **机械性相邻冲突**（例如 import 列表、路由/配置数组两侧各自追加了不同条目）：双向保留（`both`），调整排序/格式后确保类型检查与 lint 通过。
- **已被上游原生修复的小 Bug 临时补丁**：采纳上游修复并删除对应的临时补丁代码。

### B. 必须暂停并交由用户拍板（严禁静默覆盖）

遇到以下任一情况，**必须停止自动合并或提交，按下方汇报模板整理方案交由用户决策**：

1. **功能级重叠**（包含 Git 无字面冲突但语义/功能重叠的情况）：上游实现了与第 5 节《二开定制清单》同类的能力。必须列出对比（上游方案优缺点 vs 自研方案优缺点 vs 长期合并/维护成本）以及明确推荐建议，由用户决定「切换上游 / 保留自研 / 融合二者」。
2. **架构或契约破坏性变更**：上游重构了二开依赖的 `packages/contracts`、orchestrator、store 或核心组件，导致需要较大重写才能适配。
3. **行为语义冲突**：同一逻辑、默认配置、快捷键或交互设计上，上游与二开意图相反。

### C. 合并汇报模板

每次合并上游完成（或暂停请求决策）时，按以下结构向用户汇报：

1. **合并范围与摘要**：`old_sha..new_sha` 及上游本次主要变更概述。
2. **冲突清单与裁决**：每个冲突文件的裁决结果（用上游 / 保留二开 / 双向合并）及原因。
3. **潜在功能重叠与建议**：未触发字面冲突但与二开功能重叠的改动及处理建议。
4. **待决策项与验证结果**：需用户拍板的问题（如有），以及 `check:changed` / `typecheck` / 单测运行结果。

---

## 4. 降低未来合并冲突的二开编码规范

- **增量隔离优先**：定制能力尽量放在独立文件或独立模块中；对上游既有文件的改动尽量压缩为薄接入点（少量导入、注册或挂载），不在上游大文件内部大段改写。
- **不顺手重构上游代码**：严禁顺手格式化、重命名或“顺便优化”与当前需求无关的上游文件/函数，杜绝无意义的合并冲突。
- **优先扩展而非改签名**：扩展既有函数或组件时，优先采用新增导出、可选参数或薄包装层，保持上游原调用路径不变。
- **台账同步更新**：任何二开功能的新增、修改或退役，必须在同一变更（或同一次 PR/commit）中同步更新第 5 节《二开定制清单》。
- **本地环境文件不入库**：如 `.agents/skills.json` 等个人本地挂载配置禁止提交到仓库。

---

## 5. 二开定制清单（Customizations Ledger）

> **维护要求**：每次在 `lunacode` 上新增、修改或下线二开功能时，同步更新本表。合并上游前必须先对照本表评估重叠与冲突面。

| ID | 功能/优化项 | 状态 | 主要改动文件/入口 | 上游冲突默认策略 | 说明 / 退出条件 |
| --- | --- | --- | --- | --- | --- |
| `LUNA-000` | 二开分支工作流与 Agent 规则沉淀 | `active` | `AGENTS.fork.md`, `AGENTS.md`（顶部锚点）, `CLAUDE.md` | 保留 `AGENTS.fork.md`、锚点及 `@AGENTS.fork.md` 引用；`AGENTS.md` 正文全量采用上游 | Fork 基础治理规则，长期保留 |
