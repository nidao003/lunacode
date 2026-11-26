<p align="center">
  <img src="./assets/lunacode/lunacode-web-icon-192x192.png" width="88" height="88" alt="LunaCode 嫦娥图标" />
</p>

<h1 align="center">LunaCode</h1>

<p align="center">隐私优先、可自建后端的跨端 AI Coding Agent 控制面板 — 基于 <a href="https://github.com/pingdotgg/t3code">T3 Code</a> 二开。</p>

<p align="center">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <a href="#与上游-t3-code-的区别">与上游区别</a> ·
  <a href="#后端服务-docker-部署与镜像打包">后端 Docker 部署</a> ·
  <a href="#客户端配置与切换后台地址">客户端接入</a> ·
  <a href="#源码构建与运行">源码构建</a> ·
  <a href="./docs/lunacode.zh-CN.md">LunaCode 完整指南</a> ·
  <a href="./services/lunacode-connect/README.zh-CN.md">Connect 后端文档</a>
</p>

> **Fork 声明：** **LunaCode**（[`nidao003/lunacode`](https://github.com/nidao003/lunacode)）是基于 T3 Tools Inc. 开源项目 [**T3 Code**](https://github.com/pingdotgg/t3code)（MIT 协议）的独立分支。`main` 分支仅作为上游 `upstream/main` 的只读镜像；所有二开定制均位于 [`lunacode`](https://github.com/nidao003/lunacode/tree/lunacode) 分支，并与官方 `~/.t3/userdata` 保持双向兼容。

LunaCode 统一调度本机已安装的 Coding Agent，提供 **Desktop（桌面端）**、**Web** 与 **Mobile（iOS / Android）** 一致的控制界面。支持 Claude Code、Codex、Cursor、OpenCode、Grok Build、Antigravity、Kiro、Pi、Muse Code、fx、Kimi Code 及所有兼容 [ACP](./docs/user/providers-acp.md) 的 Agent，完全使用你自己的官方订阅与凭据。

---

## 与上游 T3 Code 的区别

### 核心差异总览表

| 维度                     | 上游 T3 Code（`pingdotgg/t3code`）                  | LunaCode（`nidao003/lunacode`）                                                                                                                                                                                                                  |
| ------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **应用身份与共存隔离**   | 使用官方 `T3 Code` 包名与单实例锁                   | 独立 `LunaCode` 品牌与嫦娥主题全端图标（`com.nidao003.lunacode` / `com.nidao003.lunacode.mobile`）、独立 Electron `lunacode-v2` 状态目录、启动双开检测并引导平滑退出官方 `T3 Code (Beta).app`，安全共用 `~/.t3/userdata`                         |
| **隐私与遥测默认策略**   | 默认开启 PostHog、Observe 与 Axiom 上报             | **全量默认关闭外发遥测**（`T3CODE_TELEMETRY_ENABLED=false`，永久关闭移动端 Observe 崩溃上报，无显式 token 时禁用 Axiom OTLP tracing）                                                                                                            |
| **账号与公网中继后端**   | 依赖 Clerk 商业云 + Cloudflare Workers / Zero Trust | **零依赖全自建一体化 Docker 后端**（`nidao008/lunacode-connect`，基于 Node 22 + `node:sqlite`）：邮箱账号 + OAuth2 PKCE/Device + Relay v1 + 内置二进制 WS 多路复用 `"t3_relay"` 隧道 + `/admin` 管理后台 + Webhook 离线队列 + APNs/FCM/Expo 推送 |
| **客户端后台地址配置**   | 构建期写死中继域名                                  | **公开版本零硬编码私人域名**：在 Desktop / Web / Mobile 界面内置运行时后台地址切换卡片，用户输入自己的 HTTPS 服务地址即可使用                                                                                                                    |
| **公网访问与局域网回切** | Relay 或手动配置                                    | 公网走 `t3_relay` 隧道，回到同一局域网自动通过 `ROUTE_KIND_RANK` 切回直连；支持 macOS `.local` mDNS 自动广播与自定义局域网域名切换                                                                                                               |
| **上下文与缓存透视**     | 基础上下文指示                                      | 全端零额外 Token 消耗状态栏（上下文容量、提醒阈值、缓存命中率、TTL 倒计时、`tok/s` 输出速度）+ 交互式上下文/缓存透视弹窗                                                                                                                         |
| **会话压缩与接力**       | 原生 `/compact`                                     | 可选结构化 `/compact` 模板（默认关闭）+ 确定性零 LLM 调用「摘要接力开新会话」                                                                                                                                                                    |
| **授权审批与 Git 历史**  | 审批混入工作日志或易双卡重复                        | 输入框顶部醒目单卡授权确认（直接展开允许/本会话允许/拒绝/取消与中文化操作按钮）+ Web/Mobile 全仓库只读 Git 提交历史分页与提交详情查看                                                                                                            |
| **多账号与订阅合规**     | 配额聚合展示                                        | 严格遵守官方 ToS（零流量劫持/零私钥抓取/零自动轮询号池），提供手动隔离多账号向导、分账号配额拆解与订阅档位徽章、Kimi Code 合规配额读取、Antigravity 手动刷新与 `CgBI`/媒体坏图防毒与自动会话重建                                                 |
| **更新渠道与多平台发布** | `pingdotgg/t3code` Releases                         | 切换至 `nidao003/lunacode` GitHub Releases，并由 GitHub Actions 自动产出全端安装包及 `linux/amd64` / `linux/arm64` 多架构 Docker Hub 镜像                                                                                                        |

### 已实现二开能力详述（`LUNA-001`–`LUNA-019`）

完整清单与冲突策略见 [`AGENTS.fork.md`](./AGENTS.fork.md#5-二开定制清单customizations-ledger) 及 [LunaCode 完整指南](./docs/lunacode.zh-CN.md)：

1. **全端独立身份、嫦娥主题图标与官方版安全共存（`LUNA-001`, `LUNA-002`）**
   - 桌面端与移动端使用独立 Bundle ID，隔离 `userData`（`lunacode-v2`），并保留 `~/.t3/userdata` 双向兼容；若官方版已占用锁文件，支持一键引导退出官方版后继续启动。
2. **默认零遥测与零隐私外发（`LUNA-012`）**
   - 默认关闭服务端 PostHog、移动端 Observe 崩溃上报及 Axiom Tracing。
3. **一体化 Docker 自建后端（`lunacode-connect`）与全端后台地址切换（`LUNA-017`）**
   - 无需 Cloudflare、无需 PostgreSQL、无需 Redis，单容器 Node 22 + SQLite 搞定账号认证、OAuth2、Relay 控制面、`"t3_relay"` 二进制 WS 隧道、Webhook 离线暂存重放、APNs/FCM/Expo 推送、WebSPA 托管和 `/admin` 超级管理后台。
   - 同时支持**单域名路径模式**（`https://你的域名:端口/t/<slug>/`，仅需单个证书）与**通配符泛域名模式**（`https://env-<16hex>.你的域名:端口/`，完整解锁访客链接、MCP OAuth 与跨网关联环境 PeerLinks）。
   - Desktop / Web / Mobile 内置运行时**后台登录与中继服务地址**切换器，公开产物不内置任何私人域名，切服自动清理旧会话并同步 Electron 跨域白名单。
4. **上下文状态栏、缓存透视面板与确定性接力（`LUNA-003`, `LUNA-004`, `LUNA-005`）**
   - 纯前端零 Token 开销计算缓存命中率、TTL 倒计时、平均输出速度与折算费用；提供一键确定性生成接力摘要草稿开启新对话。
5. **授权审批体验优化与只读 Git 全仓库历史（`LUNA-016`, `LUNA-018`）**
   - 将待审批权限收敛到输入框顶部唯一确认卡，拒绝误操作与重复双卡；补充 Web / Mobile 全仓库提交历史与 diff 只读浏览。
6. **多账号合规管理、Kimi 配额与 Antigravity 防护（`LUNA-006`, `LUNA-009`, `LUNA-011`, `LUNA-013`）**
   - 仅支持用户手动建立独立配置目录与手动切换，绝不提取或轮询私钥；内置 Kimi Code 配额读取（POSIX 文件锁 + Windows 只读保护）、Antigravity 手动触发配额检测、离线缓存、iOS `CgBI` 图片拦截与异常会话无感重建。
7. **局域网 `.local` 自动发现、`rtk` 助手与独立更新链路（`LUNA-007`, `LUNA-010`, `LUNA-019`）**
   - 开启网络访问时自动广播 macOS `.local` mDNS 域名并支持切换自定义局域网配对链接；支持检测并引导配置本机 `rtk`；全端更新指向 `nidao003/lunacode`。

---

## 后端服务 Docker 部署与镜像打包

自建后端 `@lunacode/connect` 源码位于 [`services/lunacode-connect/`](./services/lunacode-connect/)，无外部数据库与 npm 运行时依赖。多架构 Docker 镜像已托管至 Docker Hub：

- **Docker Hub 镜像仓库：** [`nidao008/lunacode-connect`](https://hub.docker.com/r/nidao008/lunacode-connect)（支持 `linux/amd64` 与 `linux/arm64`）

### 方式一：直接从 Docker Hub 拉取部署（推荐）

```bash
# 1. 拉取仓库中的编排配置（或仅复制 services/lunacode-connect 目录）
git clone -b lunacode --depth 1 https://github.com/nidao003/lunacode.git
cd lunacode/services/lunacode-connect

# 2. 创建环境变量并修改公开访问域名与管理员邮箱
cp .env.example .env
# 请务必修改 .env 中的：
#   PUBLIC_ORIGIN=https://connect.example.com:8443
#   TUNNEL_PUBLIC_PORT=8443
#   ADMIN_EMAILS=admin@example.com
$EDITOR .env

# 3. 一键拉取官方多架构镜像并启动（自动执行 /health 健康检查）
bash scripts/deploy.sh --pull
```

也可以直接使用 Docker Compose：

```bash
docker pull nidao008/lunacode-connect:latest
docker compose up -d
curl -fsS http://127.0.0.1:8787/health
```

### 方式二：自行打包 Docker 镜像或导出离线压缩包

如果需要在本地自行构建镜像、导出离线 `.tar.gz` 到内网/VPS 服务器，或推送到你自己的 Docker Hub 账号，可直接使用配套脚本 [`services/lunacode-connect/scripts/build-image.sh`](./services/lunacode-connect/scripts/build-image.sh)：

```bash
# A. 本地构建单架构镜像并加载到本机 Docker（自动打包 apps/web 前端 SPA 并塞入容器）
bash services/lunacode-connect/scripts/build-image.sh --load

# B. 打包并导出 linux/amd64 离线镜像包，方便上传到无公网/国内加速不便的服务器
bash services/lunacode-connect/scripts/build-image.sh \
  --platform linux/amd64 \
  --tag lunacode-connect:0.1.12 \
  --export-tar ./lunacode-connect-0.1.12-linux-amd64.tar.gz

# 在目标服务器导入并启动：
bash services/lunacode-connect/scripts/deploy.sh --tar ./lunacode-connect-0.1.12-linux-amd64.tar.gz

# C. 本地跨架构编译（amd64 + arm64）并推送到你自己的 Docker Hub
docker login -u <你的DockerHub用户名>
bash services/lunacode-connect/scripts/build-image.sh \
  --platform linux/amd64,linux/arm64 \
  --tag <你的DockerHub用户名>/lunacode-connect:latest \
  --tag <你的DockerHub用户名>/lunacode-connect:0.1.12 \
  --push
```

### 方式三：配置 GitHub Actions 自动构建并推送 Docker Hub

仓库中的 [`.github/workflows/lunacode-release.yml`](./.github/workflows/lunacode-release.yml) 已集成 `docker_connect_image` 作业。在触发发版标签或手动触发流水线时会自动编译并推送 `linux/amd64` + `linux/arm64` 双架构镜像：

1. 前往 Docker Hub → **Account Settings → Personal access tokens**，创建权限为 **Read, Write & Delete**（或 Read & Write）的 Access Token。
2. 在你的 GitHub 仓库打开 **Settings → Secrets and variables → Actions → Secrets**，新增两项 Secret：
   - `DOCKERHUB_USERNAME`：你的 Docker Hub 用户名（如 `nidao008`）
   - `DOCKERHUB_TOKEN`：刚生成的 Access Token
3. 后续推送 `lunacode-v*` 标签或执行 `workflow_dispatch` 时，CI 将自动推送 `<DOCKERHUB_USERNAME>/lunacode-connect:latest` 与 `:版本号` 镜像；若未设置上述 Secret，CI 会自动降级为单架构构建冒烟验证而不报错。

### 反向代理与 HTTPS 配置要点

容器内部监听 `8787` 端口（HTTP），公网侧请配合 Nginx / Caddy / 1Panel / Lucky / 宝塔 终结 HTTPS TLS，并注意以下 3 点：

1. **必须保留非 443 端口的 Host 头**：Nginx 必须使用 `proxy_set_header Host $http_host;`，**切勿使用 `$host`**，否则 DPoP 与 OAuth 回调端口校验会失败。
2. **开启 WebSocket 透传与关闭缓冲**：设置 `Upgrade $http_upgrade`、`Connection $connection_upgrade`、`proxy_buffering off;` 并放长超时（如 `proxy_read_timeout 3600s;`）。
3. 完整配置模板参见 [`nginx.conf.example`](./services/lunacode-connect/nginx.conf.example)、[`Caddyfile.example`](./services/lunacode-connect/Caddyfile.example) 与 [后端详细部署文档](./services/lunacode-connect/README.zh-CN.md)。

### 超级管理员后台（`/admin`）

- 在 `.env` 设置 `ADMIN_EMAILS=admin@example.com` 启动容器即可自动提权；若升级旧库且库中无管理员，最早注册的账号会自动成为超级管理员。
- 登录后访问 `https://你的服务域名/admin`，即可实时开关注册、配置邮箱白名单、修改每账号隧道数量配额（`maxTunnels`）及 `managedTunnels` / `webhooks` / `mobilePush` 权限、重置密码及吊销设备会话。

---

## 客户端配置与切换后台地址

公开打包的桌面端、Web 端与移动端 **均不含任何私人硬编码域名**，安装即可使用并在以下任意位置填写你自建的 `lunacode-connect` HTTPS 地址（例如 `https://connect.example.com:8443`）：

- **桌面端 / Web 端**：
  - 点击登录后，**登录/注册弹窗最上方**「后台登录与中继服务地址」卡片；
  - 已登录后，**账号与远程设备弹窗底部**；
  - **设置 → Labs → LunaCode 定制能力 → 后台登录与中继服务地址**。
- **移动端（iOS / Android）**：
  - **设置 → 连接/登录账号 → 后台登录与中继地址**卡片。

切换服务器地址后会自动清理原服务器会话，桌面端会自动通过 IPC 刷新 Electron 的 CORS `Origin` 放行列表。

> 如需在自有 Fork 编译产物中预置默认服务地址，只需在仓库根目录 `.env` 或 GitHub Actions Repository Variables 中设置 `LUNACODE_CONNECT_URL=https://connect.example.com:8443`；若需彻底隐藏云登录入口，设为 `LUNACODE_CONNECT_URL=off`。

---

## 设计铁律（Guardrails）

1. **官方订阅合规**：绝不做流量 MITM 劫持、绝不私抽 Keyring/token、绝不伪造客户端 UA、绝不在后台跑偷跑模型调用或自动轮询号池。
2. **零额外 Token 损耗**：上下文计量、缓存命中分析、费用估算及接力摘要生成均为本地确定性计算。
3. **零上下文降智**：绝不静默删改 System Prompt、reasoning effort、工具定义或原始错误栈。
4. **上游数据兼容**：完整保留 `~/.t3/userdata/statev2.sqlite` 数据结构，可随时与官方版无损互切。

---

## 源码构建与运行

> **分支规范：** 始终基于 `lunacode` 分支开发（严禁向只读上游镜像 `main` 提交）。完整流程见 [`AGENTS.fork.md`](./AGENTS.fork.md)。

```bash
git clone -b lunacode https://github.com/nidao003/lunacode.git
cd lunacode
vp i
```

### 启动桌面端 / Web 开发环境

```bash
vp run dev
```

### 本地签名打包 macOS Desktop DMG（`arm64`）

```bash
bash .claude/skills/lunacode-mac-dmg/scripts/build-signed-dmg.sh
```

会在 `release/` 生成带本地 `Apple Development` 签名的 `LunaCode-<version>-arm64.dmg`（可加 `--unsigned` 生成未签名包）。

### 构建移动端（iOS & Android）

参阅 [`apps/mobile/README.md`](./apps/mobile/README.md) 与 [`docs/operations/00_development.md`](./docs/operations/00_development.md)。

---

## 相关文档导航

- [English README](./README.md)
- [LunaCode 完整功能指南](./docs/lunacode.zh-CN.md)（[English](./docs/lunacode.md)）
- [lunacode-connect 后端部署与镜像构建指南](./services/lunacode-connect/README.zh-CN.md)（[English](./services/lunacode-connect/README.md)）
- [lunacode-connect 架构与协议设计](./docs/lunacode-connect-plan.md)
- [二开流程规范与定制台账（`AGENTS.fork.md`）](./AGENTS.fork.md)
- [文档总索引](./docs/README.md)

---

## 致谢与协议

LunaCode 基于 [**T3 Code (`pingdotgg/t3code`)**](https://github.com/pingdotgg/t3code) 构建，原作者为 Theo Browne、Julius Marminge 与 T3 Tools Inc.。源码采用 [MIT 开源协议](./LICENSE)。

MIT 协议**仅涵盖源代码**，不包含 T3 Tools, Inc. 的商标、徽标或官方品牌标识；参见 [TRADEMARK.md](./TRADEMARK.md)。
