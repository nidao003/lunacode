# LunaCode 功能与二开完整指南

<p>
  <a href="./lunacode.md">English</a> · <strong>简体中文</strong>
</p>

> **上游来源：** **LunaCode**（[`nidao003/lunacode`](https://github.com/nidao003/lunacode)）基于 T3 Tools Inc. 开源项目 [**T3 Code (`pingdotgg/t3code`)**](https://github.com/pingdotgg/t3code)（MIT 协议）进行二开增强。

LunaCode 完整保留了上游 T3 Code 的多模型 Orchestrator 调度核心、远程控制架构与 `~/.t3/userdata` 数据库兼容性，并重点增加了**默认零遥测隐私保护**、**全自建 Docker 一体化后端与 `"t3_relay"` 隧道（`nidao008/lunacode-connect`）**、**全端运行时后台地址配置卡片**、**官方合规多账号配额拆解**、**跨端上下文/缓存状态条与透视面板**、**显性授权确认卡与全仓库只读 Git 历史**、**局域网 `.local` mDNS 配对**、**Antigravity 坏图与会话自动恢复**以及**声明式 `*.flow.json` 可视化工作流工作室**能力。

---

## 1. 分支规范与官方版安全共存（`LUNA-001`, `LUNA-002`）

- **分支约定：**
  - `main`：仅作为 GitHub Actions 自动同步 `upstream/main` 的只读镜像，**严禁在 `main` 上开发或提交**。
  - `lunacode`：所有定制功能与发布的主开发分支。
  - 定期合并上游流程见 [`AGENTS.fork.md`](../AGENTS.fork.md#2-定期合并上游标准流程upstream-merge-sop)。
- **桌面/移动双开共存：**
  - 独立打包为 **LunaCode**（桌面端 `com.nidao003.lunacode`，移动端 `com.nidao003.lunacode.mobile`），独立 Electron `userData`（`lunacode-v2`）、嫦娥月兔图标集（`assets/lunacode/`），并将桌面 `electron-updater`、CLI/Server 更新及移动端检查指向 `nidao003/lunacode` Releases（`LUNA-019`）。
  - 继续与官方 `T3 Code (Beta).app` 共用 `~/.t3/userdata`，启动时检测官方版占用锁并提供一键引导平滑退出后再继续启动。

---

## 2. 隐私与遥测默认策略（`LUNA-012`）

- **服务端产品分析默认关闭：** [`AnalyticsService.ts`](../apps/server/src/telemetry/AnalyticsService.ts) 默认 `T3CODE_TELEMETRY_ENABLED=false`，仅在显式设置为 `true` 时启用。
- **移动端崩溃上报永久禁用：** [`observe.ts`](../apps/mobile/src/features/observability/observe.ts) 中禁用 `expo-observe`。
- **移动端 OTLP 链路追踪按需开启：** [`tracing.ts`](../apps/mobile/src/features/observability/tracing.ts) 禁用上游默认 Axiom 凭证，仅当配置自有 `EXPO_PUBLIC_OTLP_TRACES_TOKEN` 时生效。

---

## 3. 全自建 Docker 后端（`lunacode-connect`）与远程接入（`LUNA-017`）

上游依赖 Clerk 商业登录服务和 Cloudflare Workers/Zero Trust 隧道；LunaCode 提供完全可私有化、零外部数据库与零外部 npm 依赖的一体化后端容器：

- **Docker Hub 官方多架构镜像：** [`nidao008/lunacode-connect`](https://hub.docker.com/r/nidao008/lunacode-connect)（`linux/amd64` + `linux/arm64`，基于 Node 22 + `node:sqlite`）。包含：
  - 邮箱注册登录 + Session + EdDSA (Ed25519) JWT & JWKS
  - CLI OAuth2 PKCE + `/connect` 授权页 + Device Code 无头设备码流程
  - Relay v1 控制面 + 内置二进制 WS 多路复用 `"t3_relay"` 隧道网关
  - Webhook 中继转发 + 24 小时离线暂存重放队列
  - Agent 实时感知与原生推送（APNs HTTP/2 + iOS Live Activity、Android FCM HTTP v1、Expo Push 兜底）
  - 可选容器内置 Web SPA（`WEB_DIST_DIR=/app/web-dist`）与 `/admin` 超级管理后台（用户隧道上限、能力权限开关、注册白名单、设备会话管理）
- **单域名与泛域名双路由模式：** 原生支持非 443 端口（如 `:8443`）；默认单域名路径前缀模式（`/t/<slug>/`）仅需单个域名和单张 TLS 证书即可挂载任意多台主机，亦可通过 `TUNNEL_WILDCARD_DOMAIN` 开启泛域名独立子域解锁访客链接、MCP OAuth 与跨网关联环境。
- **零硬编码私人域名与全端手动配置：**
  - 公开源码及发行版构建默认启用自建认证模式（`LUNACODE_SELF_HOSTED_AUTH=1`），**不预埋任何私人后端域名**。
  - 桌面端、Web 端与移动端均内置可视化「后台登录与中继服务地址」切换卡片；修改后立即持久化，清理旧服务会话，并通过 IPC（`luna:set-auth-url`）自动更新桌面 Electron CORS 放行域名。
- **回局域网自动直连切换：** 客户端外网走 `t3_relay` HTTPS/WSS，回到同一局域网后由 `ROUTE_KIND_RANK` 自动探测并切换回局域网 IP 或 `.local` mDNS 直连（`lan: 1 < relay: 5`）。
- 部署命令与打包脚本请查看 [`../services/lunacode-connect/README.zh-CN.md`](../services/lunacode-connect/README.zh-CN.md)，协议细节请查看 [`./lunacode-connect-plan.md`](./lunacode-connect-plan.md)。

---

## 4. Web 与移动端效率与交互增强

核心逻辑抽离于 `packages/client-runtime/src/lunacode/`，Web/Desktop（`apps/web/src/lunacode/`）与 Mobile（`apps/mobile/src/lunacode/`）双端同步支持：

- **上下文与缓存状态条 / 透视面板 / 均速徽章（`LUNA-003`, `LUNA-004`）：**
  - 纯本地 usage 数据零额外 Token 开销，实时显示上下文占比、提醒阈值、缓存命中率、TTL 倒计时与回复速度（`tok/s`），点击弹出详细透视面板（容量构成、缓存归因、折算 API 费用、轮次统计）。
- **结构化 `/compact` 与确定性接力（`LUNA-005`）：**
  - 结构化压缩模板默认关闭（按需开启）；支持「一键摘要接力开新会话」，完全通过本地对话状态生成新窗口草稿，不偷调模型。
- **授权确认单卡收敛与全仓库只读 Git 历史（`LUNA-018`, `LUNA-016`）：**
  - 恢复输入框顶部醒目的单卡授权确认栏并中文化常见审批选项，避免时间线与输入框双卡重叠。
  - 在 Web Diff 面板与移动端 Git 概览弹窗新增仓库级提交历史分页浏览与提交详情查看（仅只读查询）。
- **局域网 `.local` mDNS 发现与自定义域名配对（`LUNA-010`）：**
  - 开启网络访问时自动探测本机 `.local` 主机名，支持在 Settings → Sharing & access 一键切换 IP / `.local` / 自定义局域网域名生成配对二维码。
- **`rtk` 终端输出降噪助手（`LUNA-007`）：**
  - 仅作本地检测与命令引导，不主动修改或丢失关键报错上下文。
- **Human-in-the-Loop 可视化工作流工作室（`*.flow.json`，`LUNA-020`）：**
  - 在完整兼容上游编程式 `.ts` / `.js` 工作流的基础上，新增声明式 `*.flow.json`（`FlowSpec` v1）执行引擎，支持 DAG 并行扇出/扇入、有界 `isLoop` + `maxHops` 人工审批熔断、零 Token `precheck` 门槛、`<untrusted_event_data>` 隔离及同项目并发 `root` 写冲突校验。
  - 内置 8 套精选工作流模板（首次启动通过 `.lunacode-flow-presets.json` 单次自动预置 `bug-repro-fix`、`pr-dual-review`、`ci-doctor-autofix`、`docs-drift-sync`、`release-notes-prep`、`daily-repo-standup` 共 6 套 `manual` 案例，另提供 `issue-triage` 与 `feature-plan-ship` 按需导入）。
  - 提供 `workflows.start` RPC 与对话内 `t3_flow_*` MCP 工具（支持多版本流迭代），并在 Web / Desktop 提供交互式 DAG 画布编排与实时运行流视图，在 Mobile 同步提供竖向阶段 DAG 编排与一键案例导入。

---

## 5. 多账号合规、配额拆解与稳定性加固（`LUNA-006`, `LUNA-008`, `LUNA-009`, `LUNA-011`, `LUNA-013`）

- **官方订阅红线（`LUNA-011`）：** 100% 走官方 CLI/ACP 通道；禁止读取私密 Keyring/OAuth token、禁止硬编码第三方 CLI 密钥、禁止伪造 UA/IDE 身份、禁止在个人订阅上隐藏发起辅助 LLM 调用。
- **手动多账号隔离与分账号配额视图（`LUNA-006`）：** 引导创建隔离配置目录（严格手动切换，不做号池轮询），模型选择器与侧边栏直接展示单账号余量与订阅档位徽章。
- **Kimi Code 合规配额接入（`LUNA-009`）：** 基于官方凭据文件配合 POSIX 文件锁与 Windows 只读保护读取 `/me` 和 `/usages`，带 5 分钟缓存和单轮防并发忙碌守卫。
- **Antigravity 手动刷限与媒体防毒（`LUNA-011`, `LUNA-013`）：** 仅用户点击刷新时在隔离 `HOME` 下执行 `agy --print /usage --output-format json`（5 分钟冷却 + 本地离线缓存）；发送附件前拦截空文件、坏图头和苹果 iOS 私有 `CgBI` PNG，一旦触发 `INVALID_MEDIA_INPUT` 自动标记损坏并在下一轮无感重建健康会话。
- **OpenViking 云端记忆（`LUNA-008`，已下线）：** 由各 Agent CLI 自带插件通过 `~/.openviking/ovcli.conf` 统一处理，不再在 LunaCode 内重复实现。

---

## 6. 本地开发与打包命令

```bash
# 安装依赖（确保处于 lunacode 分支）
vp i

# 启动本地研发环境（Server + Web）
vp run dev

# 打包本地苹果签名 macOS arm64 DMG
bash .claude/skills/lunacode-mac-dmg/scripts/build-signed-dmg.sh

# 本地构建服务端 Docker 镜像
bash services/lunacode-connect/scripts/build-image.sh --load
```

移动端（iOS / Android）原生构建说明参见 [`apps/mobile/README.md`](../apps/mobile/README.md) 与 [`docs/operations/00_development.md`](./operations/00_development.md)。
