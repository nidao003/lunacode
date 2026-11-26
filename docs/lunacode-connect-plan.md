# LunaCode 自建账号与公网远程访问开发及部署方案（LUNA-017 / B 方案）

## 1. 背景与现状分析

### 1.1 为什么当前无法直接远程访问与登录

1. **构建期云配置未注入**：客户端与服务端通过 `hasCloudPublicConfig`（基于 `.env` / CI 环境变量注入 `T3CODE_CLERK_PUBLISHABLE_KEY`、`T3CODE_RELAY_URL` 等）决定是否启用远程账号登录与中继（Relay）。LunaCode 默认打包未配置上述变量，因此相关登录入口与远程链路处于隐藏状态。
2. **上游 Clerk 与 Cloudflare 隧道无法直接复用**：
   - 上游 `clerk.t3.codes` 与 LunaCode 的 Bundle ID（`com.nidao003.lunacode` / `com.nidao003.lunacode.mobile`）、macOS Passkey RP ID、Deep Link（`lunacode://`）及桌面应用包名不一致，无法复用其 OAuth / Passkey / Session 体系。
   - 上游 Relay（`infra/relay`）绑定 Cloudflare Workers + Durable Objects + Zero Trust Tunnel，无法在普通 Docker 服务器中开箱即用。

### 1.2 已具备的多端路由切换基础

`packages/client-runtime` 已经内置完整的连接优先级与热切换机制：

- 路由优先级常量 `ROUTE_KIND_RANK`（`packages/client-runtime/src/connection/routes.ts`）：
  - `loopback: 0` > `lan: 1` > `tailnet/vpn: 2` > `public: 3` > `ssh: 4` > `relay: 5`
- 服务端在连接建立后下发 `serverConfig.directEndpoints`（含本机回环、局域网 IP、mDNS `.local` 等直连地址），客户端通过 `EnvironmentRegistry.learnRoutes` 学习并合并路由。
- `EnvironmentSupervisor` 会在网络状态变化、应用切回前台以及每 60 秒周期探测更高优先级路由；一旦设备回到局域网且直连可达，客户端自动切回直连，不再绕行公网中继。

---

## 2. 总体架构设计（B 方案：一体化自建 Connect 服务 + `"t3_relay"` 内置隧道）

```text
+-------------------+       HTTPS / WSS        +----------------------------------+
| Web / Desktop /   | <----------------------> | Reverse Proxy (Caddy / Nginx)    |
| Mobile / CLI      |   connect.<domain>       | TLS Termination (Wildcard HTTPS) |
+-------------------+   <env>.connect.<domain> +----------------------------------+
         ^                                                      |
         | (Same LAN: auto switch back                          | HTTP/1.1 + WS Upgrade
         |  to http://<ip>:3773 or .local)                      v
         |                                     +----------------------------------+
         +-----------------------------------> | Docker: lunacode-connect         |
                                               | (Node 22 + node:sqlite, 0 deps)  |
+-------------------+   WSS Multiplex Tunnel   | - Auth + OAuth2 PKCE/Device      |
| User's Local      | =======================> | - Relay Control Plane (v1)       |
| LunaCode Server   |  /_tunnel/connect        | - Binary Multiplex Tunnel Hub    |
+-------------------+                          +----------------------------------+
```

### 核心设计原则

1. **单入口配置**：通过 `LUNACODE_CONNECT_URL`（公开源码默认留空，按各用户自部署后端地址在客户端登录弹窗或设置页输入，或通过 `.env`/CI 注入如 `https://connect.example.com:8443`）统一配置认证地址（`LUNACODE_AUTH_URL`）、中继地址（`T3CODE_RELAY_URL`）与托管页地址（`T3CODE_HOSTED_APP_URL`），亦支持分别覆盖。
2. **零外部 npm 依赖**：后端 `services/lunacode-connect` 仅使用 Node.js 22 内置模块（`node:http`、`node:crypto`、`node:sqlite` 等），独立于 `pnpm-workspace.yaml`，容器体积小、离线导入即可启动。
3. **无 `cloudflared` 依赖的 `"t3_relay"` 隧道**：在 `packages/contracts/src/relay.ts` 新增 `"t3_relay"` provider 类型，服务端内置 WebSocket 多路复用隧道客户端（`apps/server/src/lunacode/t3RelayTunnelClient.ts`），本地宿主直接主动外连自建 Connect 服务器的 `/_tunnel/connect` 通道，无需配置家庭公网端口映射或安装 Cloudflare 二进制工具。
4. **单域名自定义端口（`:8443`）即开即用**：同时支持「单域名路径前缀模式 `/t/<tunnelSlug>/`」（默认，仅需单域名与单张证书即可挂载任意多台环境）与「通配符子域名模式 `<slug>.<TUNNEL_WILDCARD_DOMAIN>`」。
5. **双模平滑兼容**：Web / Desktop / Mobile / CLI 同时支持自建认证（`lunacode`）与原有 Clerk 路径（`clerk`），保证上游单元测试继续通过，未来也可按配置自由切换。

---

## 3. 认证与授权体系设计

### 3.1 数据模型（SQLite `data/connect.sqlite`）

- `users`: `id`, `email`（唯一）, `password_hash`（`scrypt` + 随机盐）, `display_name`, `created_at`
- `sessions`: `token_hash`（SHA-256）, `user_id`, `expires_at`, `created_at`（支持 Cookie 与 `Authorization: Bearer`）
- `oauth_codes`: `code_hash`, `user_id`, `client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method`, `scope`, `expires_at`, `used_at`
- `device_codes`: `device_code_hash`, `user_code`, `client_id`, `scope`, `user_id`, `approved_at`, `expires_at`, `interval_sec`
- `refresh_tokens`: `token_hash`, `user_id`, `client_id`, `scope`, `expires_at`, `revoked_at`
- `environments` / `environment_links` / `tunnels`: 环境元数据、Ed25519 公钥指纹、隧道密钥哈希、绑定主机名、状态记录

### 3.2 Ed25519 JWT 与 JWKS

- 启动时自动生成并持久化非对称 Ed25519 密钥对（或通过环境变量注入）。
- 提供标准 JWKS 端点 `GET /.well-known/jwks.json` 与 `GET /api/auth/jwks`。
- 签发短期 Access Token（JWT，头含 `alg: "EdDSA"`, `kid`，载荷含 `sub`, `email`, `iss`, `aud`, `iat`, `exp`），与客户端及 Relay 验签逻辑兼容（`packages/shared/src/relayJwt.ts`）。

### 3.3 多端登录与 CLI 授权流

1. **Web / Desktop（Electron）/ Mobile（React Native）**：
   - 登录 `POST /api/auth/login`
   - 注册 `POST /api/auth/register`
   - 刷新与当前会话 `GET /api/auth/session`、`POST /api/auth/token`、`POST /api/auth/logout`
2. **CLI 授权流（复用 `CliTokenManager` 接口）**：
   - **PKCE 浏览器授权**：CLI 启动本地回环端口（默认 `34338`）并跳转 `GET /connect`（或 `/oauth/authorize`），用户登录授权后重定向回 `http://127.0.0.1:34338/callback?code=...&state=...`，再通过 `POST /oauth/token` 换取 Access Token + Refresh Token。
   - **Device Code 设备码流（无头/SSH 环境）**：`POST /oauth/device/code` 获取 `user_code` 与验证页 `/oauth/device`，用户确认后 CLI 轮询 `POST /oauth/token` 完成绑定。

---

## 4. Relay 控制面与 WebSocket 多路复用隧道

### 4.1 控制面接口（对齐 `packages/contracts/src/relay.ts`）

- `GET /health`：健康检查，返回 `{ ok: true, service: "relay" }`。
- `GET /.well-known/oauth-authorization-server` 与 `GET /.well-known/oauth-protected-resource`：DPoP 与 OAuth 发现元数据。
- `GET /v1/environments`：返回当前用户关联的环境列表、主/备端点及隧道状态。
- `POST /v1/client/environment-link-challenges` 与 `POST /v1/client/environment-links`：签发绑定 challenge、校验本地宿主提交的 `linkProof`、分配 `"t3_relay"` 隧道凭证与独立域名。
- `DELETE /v1/client/environment-links/:environmentId` 与 `DELETE /v1/client/environment-links/:environmentId/tunnel`：撤销环境绑定或释放隧道。
- `POST /v1/client/dpop-token`：将登录态 Access Token 换取绑定客户端 DPoP 公钥的令牌。
- `POST /v1/environments/:environmentId/connect` 与 `POST /v1/environments/:environmentId/status`：签发客户端访问特定环境的短期凭证并探测在线状态（透传/调用环境 `/api/cloud/health` 与 `/api/cloud/mint`）。
- `POST /v1/environments/:environmentId/tunnel/recovery`、`POST /v1/environments/:environmentId/tunnel` 与 `POST /v1/environments/:environmentId/link-preferences`：注册/恢复隧道与同步绑定偏好。
- 移动设备推送注册（`GET /v1/client/devices`、`/v2/client/devices`、`POST/DELETE /v1/mobile/devices`）与 `GET /v1/client/t3chat-link` 兼容接口（确保多端 UI 初始化零报错）。

### 4.2 三种隧道路由模式与路径前缀 / DPoP 兼容

`services/lunacode-connect` 支持三种隧道路由方式，并从 `PUBLIC_ORIGIN`（或 `TUNNEL_PUBLIC_PORT`）自动保留非 443 端口（如 `:8443`）：

1. **单域名路径前缀模式（默认，`https://connect.example.com:8443/t/<tunnelSlug>/`）**：
   - 未设置 `TUNNEL_WILDCARD_DOMAIN` 或独立 `TUNNEL_SINGLE_DOMAIN` 时自动启用。
   - 网关拦截 `/t/<tunnelSlug>/...` HTTP 与 WebSocket 升级请求，剥离 `/t/<tunnelSlug>` 前缀转发至本地 `apps/server`，同时保留原始 `Host`（含 `:8443`）、`X-Forwarded-Proto` 与 `X-Forwarded-Prefix: /t/<tunnelSlug>`。
   - `t3RelayTunnelClient.ts` 转发本地时保留原始 `Host` 头；`apps/server/src/auth/dpop.ts` 中的 `resolveDpopRequestUrl` 校验并拼接合法 `/t/<slug>` 前缀进行 DPoP `htu` 验签，客户端 `packages/client-runtime` 的 URL 构造器保持路径前缀拼接。
   - 仅需单个域名与单张证书即可同时挂载多台环境，且控制面（`/api/auth/*`、`/oauth/*`、`/.well-known/oauth-*`）与隧道端（`/t/<slug>/.well-known/t3/environment`）零冲突。
2. **通配符子域名模式（可选）**：设置 `TUNNEL_WILDCARD_DOMAIN=connect.example.com` 后分配 `https://<slug>.connect.example.com[:port]/`。
3. **独立单环境主机名模式（可选）**：设置与主站不同的 `TUNNEL_SINGLE_DOMAIN`，将该域名的全部流量直转指定单台环境。

### 4.3 二进制 WebSocket 多路复用帧协议

本地 LunaCode Server 通过出站 WSS 连接到 `wss://<CONNECT_HOST>/_tunnel/connect`（携带 `x-lunacode-tunnel-id` 与 `Authorization: Bearer <tunnelToken>`）。网关收到来自公网客户端发往 `<slug>.<domain>` 的 HTTP 请求或 WebSocket 升级请求后，通过同一条隧道长连接多路复用转发至本地 `127.0.0.1:<port>`：

- 所有数据帧格式：`[uint8 type][uint32BE streamId][payload...]`
- 帧类型：
  - `0x01 OPEN_HTTP`：payload 为 JSON `{ method, url, headers }`
  - `0x02 HTTP_HEAD`：payload 为 JSON `{ statusCode, statusMessage, headers }`
  - `0x03 DATA`：HTTP 请求体/响应体或 WS 二进制数据分片
  - `0x04 END`：单方向 EOF
  - `0x05 CLOSE`：流异常关闭（可选 JSON `{ error }`）
  - `0x06 OPEN_WS`：payload 为 JSON `{ url, headers }`
  - `0x07 WS_ACK`：payload 为 JSON `{ statusCode, headers }`
  - `0x08 PING` / `0x09 PONG`：心跳保活（默认 25s 间隔）
- 背压控制：对单个 `streamId` 设置发送/缓冲上限，连接断开时清理全部活动流避免泄漏。

---

## 5. 公网访问与局域网回切行为说明

1. **公网远程访问**：
   - 登录自建账号后，客户端从 `/v1/environments` 拉取环境信息及 `https://<env>.connect.<domain>` 路由（等级 `relay: 5`）。
   - 在外网或 4G/5G 下，直连候选探测超时/失败，客户端自动选中 `relay` 路由并通过自建网关接入本地 LunaCode Server。
2. **回到同一局域网后的自动回切**：
   - 宿主机的 `DirectEndpoints.resolveAvailable` 在通配监听（如 `0.0.0.0`）且存在有效局域网网卡时，下发 `http://<lan-ip>:<port>` 与 `http://<hostname>.local:<port>`（均为 `kind: "lan"`, 等级 `1`）。
   - 客户端 `EnvironmentSupervisor` 在网络切换（`online` / `NetInfo`）、回到前台或 60 秒轮询时重新并发探测；`lan`（rank 1）探测成功后立即胜出并切换为局域网直连，不经公网中继。
3. **浏览器 Mixed-Content 限制说明**：
   - **Desktop（Electron）与 Mobile（iOS/Android）**：不受 HTTPS 页面访问 `http://` 局域网地址限制，可完整实现「公网走 HTTPS Relay，回局域网自动走 HTTP LAN 直连」。
   - **Web 浏览器**：若页面本身运行在 `https://<connect-domain>`，浏览器安全策略会阻止 HTTPS 页面向非 localhost 的明文 `http://192.168.x.x` 发起 XHR/WS；只有本地打开 `http://localhost` / `http://<lan-ip>` 的 Web 页面或局域网同样部署 HTTPS 时，Web 才可回切局域网直连。这是浏览器底层安全机制，应在文档与提示中明确告知用户。

---

## 6. Docker 部署与公网 HTTPS 反向代理指南

Backend 目录位于 `services/lunacode-connect/`，提供即用型 `Dockerfile`、`docker-compose.yml`、`.env.example`、`Caddyfile.example` 与 `nginx.conf.example`。离线镜像导出包位于 gitignored 目录 `release/lunacode-connect-deploy/`（含 `lunacode-connect-linux-amd64.tar.gz`、`docker-compose.yml`、`.env.example`、`nginx.conf.example`）。

### 6.1 前置条件（示例 `connect.example.com:8443`）

1. 服务器已有公网 HTTPS 反向代理（Nginx / 1Panel / 宝塔 / Lucky / 群晖 / Caddy）在 `:8443` 端口终结 TLS，并反代至容器 `127.0.0.1:8787`。
2. （仅通配符子域名模式需要）补充通配符 DNS 解析 `*.domain` 与通配符证书；默认单域名 `/t/<slug>/` 模式**不需要**。

### 6.2 环境变量配置（`.env`）

| 变量名                   | 说明                                           | 默认 / 示例值                      |
| ------------------------ | ---------------------------------------------- | ---------------------------------- |
| `PORT`                   | 容器内监听 HTTP 端口                           | `8787`                             |
| `DATA_DIR`               | SQLite 与 Ed25519 密钥存储目录                 | `/data`                            |
| `PUBLIC_ORIGIN`          | 主站/认证/Relay 对外 HTTPS 地址                | `https://connect.example.com:8443` |
| `TUNNEL_BASE_SCHEME`     | 外部访问隧道协议                               | `https`                            |
| `TUNNEL_PUBLIC_PORT`     | 隧道 URL 显式端口（默认继承 `PUBLIC_ORIGIN`）  | `8443`                             |
| `TUNNEL_WILDCARD_DOMAIN` | 可选通配符泛域名根（留空走 `/t/<slug>/`）      | ``                                 |
| `ALLOW_REGISTRATION`     | 是否开放自助注册（可在 `/admin` 动态覆写）     | `true`                             |
| `ALLOWED_EMAILS`         | 可选白名单邮箱（逗号分隔，可在 `/admin` 覆写） | ``                                 |
| `ADMIN_EMAILS`           | 超级管理员邮箱列表（逗号分隔，启动自动升权）   | ``                                 |
| `ADMIN_EMAIL`            | 可选默认初始化超管账号邮箱                     | ``                                 |
| `ADMIN_PASSWORD`         | 与 `ADMIN_EMAIL` 配套的初始密码（至少 8 位）   | ``                                 |
| `CORS_ALLOWED_ORIGINS`   | 额外允许跨域的 Web 来源                        | ``                                 |

### 6.3 导入镜像并启动容器

```bash
# 1. 上传 lunacode-connect-linux-amd64.tar.gz、docker-compose.yml、.env.example 到服务器目录
docker load -i lunacode-connect-linux-amd64.tar.gz
cp .env.example .env
docker compose up -d
```

验证容器健康检查：

```bash
curl -fsS http://127.0.0.1:8787/health
curl -fsSI http://127.0.0.1:8787/
```

### 6.4 反向代理要求（Nginx / Caddy）

- **关键要求**：反向代理转发至 `127.0.0.1:8787` 时**必须保留端口**（Nginx 使用 `proxy_set_header Host $http_host;`，切勿使用不带端口的 `$host`），透传 `X-Forwarded-Proto $scheme`（或 `https`），启用 WebSocket `Upgrade` / `Connection` 头部，禁用缓冲并放长超时（`proxy_buffering off`、`proxy_read_timeout 3600s`）。参考 `services/lunacode-connect/nginx.conf.example` 与 `Caddyfile.example`。

### 6.5 超级管理员与 `/admin` 后台管理

- **历史库无损升级**：升级镜像并启动容器时，`connect.sqlite` 会自动执行增量建表与字段迁移（保留全部已注册用户与设备绑定）。若库内尚无活跃 `admin` 且未显式指定 `ADMIN_EMAILS`/`ADMIN_EMAIL`，系统自动将最早注册的用户提升为超级管理员；也可通过 `.env` 配置 `ADMIN_EMAILS=admin@example.com` 后重启容器显式指定。
- **管理控制台**：登录超管账号后访问 `https://<public-origin>/admin`（或在已登录主页点击「管理后台 /admin」），即可动态开关自助注册、编辑白名单邮箱、创建/删除/禁用用户、重置密码、调整 `user`/`admin` 角色及踢下线或吊销在线设备。

---

## 7. 客户端与 GitHub Actions 构建接入

仓库默认构建配置（`scripts/lib/public-config.ts`、`.env.example`、`.github/workflows/lunacode-release.yml`）已注入 `LUNACODE_SELF_HOSTED_AUTH=1`，**不在公开包内硬编码任何私人域名**（若显式设置了 `LUNACODE_CONNECT_URL` / `T3CODE_CLERK_*` 或 `LUNACODE_CONNECT_URL=off` 则按显式配置生效）；用户安装客户端后即可在登录弹窗或设置页填写/切换自己的 `lunacode-connect` 后台地址。全端应用与 CLI 更新源默认指向 **`nidao003/lunacode`** GitHub Releases（兼容 `lunacode-v*` 标签）。

### 7.1 本地构建 / 源码运行

不配置 `.env` 时客户端保留自建认证入口并在首次使用时提示输入后台地址；如需把固定地址直接打包进客户端，在仓库根目录 `.env` 中设置：

```dotenv
LUNACODE_CONNECT_URL=https://your-domain.example.com:8443
```

### 7.2 GitHub Actions 云端打包

在 `.github/workflows/lunacode-release.yml` 中默认环境变量设为自建无硬编码模式：

```yaml
LUNACODE_CONNECT_URL: ${{ vars.LUNACODE_CONNECT_URL }}
```

后续如需让 GitHub Actions 产出的安装包预置默认服务端地址，只需在 GitHub 仓库 `Settings -> Secrets and variables -> Actions -> Variables` 添加 `LUNACODE_CONNECT_URL` 即可；Docker 镜像推送则读取 `DOCKERHUB_USERNAME` 与 `DOCKERHUB_TOKEN` Secret。

---

## 8. 分阶段实施计划与验收标准

| 阶段                                    | 内容                                                                                                                                                                                                                                                     | 验收方式                                                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phase 1：文档与台账**                 | 编写 `docs/lunacode-connect-plan.md`，更新 `.env.example`、`docs/lunacode.md`、`AGENTS.fork.md`（`LUNA-017`）                                                                                                                                            | 文档完整、路径准确                                                                                                                          |
| **Phase 2：Docker 后端**                | 实现 `services/lunacode-connect` 认证、OAuth2、Relay API、二进制 WS 隧道网关与 Docker 配置                                                                                                                                                               | `node --experimental-strip-types --test services/lunacode-connect/test/connect.test.ts` 全通过                                              |
| **Phase 3：服务端隧道与 LAN `.local`**  | 扩展 `t3_relay` 契约，实现 `t3RelayTunnelClient.ts`，接入 `ManagedEndpointRuntime` / `CloudLink` / `DirectEndpoints`                                                                                                                                     | 服务端单测 + `routes.test.ts` LAN 优先级验证通过                                                                                            |
| **Phase 4：多端双模认证与 CI**          | 改造 `public-config.ts`、CLI、Desktop、Web、Mobile（无新依赖/兼容现有单测）及 release workflow                                                                                                                                                           | 各端 `publicConfig.test.ts`、`DesktopClerk.test.ts` 通过                                                                                    |
| **Phase 5：全量类型与变更校验**         | 执行受影响单元测试、`vp run typecheck`、`vp run check:changed`                                                                                                                                                                                           | 零错误且无非计划遗留文件                                                                                                                    |
| **Phase 6：超管后台与自建源更新**       | 补齐 `lunacode-connect` 超管 `/admin` 控制台与旧库升级迁移；全端桌面/CLI/SSH/安装脚本/移动端更新源切换至 `nidao003/lunacode`                                                                                                                             | `connect.test.ts` 3/3、更新链单测、`check:changed` 与 Docker `linux/amd64` 冒烟验证全通过                                                   |
| **Phase 7：泛域名、配额与完整后端能力** | 启用通配符泛域名（`X-Tunnel-Public-Host` 透传，解锁访客链接 / MCP OAuth / 跨网关联环境）、管理员可配隧道配额与功能权限、定时任务 Webhook 中继与离线暂存重放、移动端 Agent 感知与 APNs/FCM/Expo 推送、容器托管 WebSPA（`WEB_DIST_DIR`）与账号自助安全设置 | `connect.test.ts`、`t3RelayTunnelClient.test.ts`、`t3ConnectWildcard.test.ts`、类型检查、`check:changed` 与 Docker 容器全路径冒烟验证全通过 |

---

## 9. Phase 7 扩展能力（泛域名、配额权限、Webhook、推送与 WebSPA 托管）

1. **泛域名独立隧道（`TUNNEL_WILDCARD_DOMAIN=example.com` + `TUNNEL_PUBLIC_PORT=8443`）**
   - `t3_relay` 对齐 `lunacode-<16hex>` / `env-<16hex>` 十六进制后缀约束，启动自动将旧单域 `/t/<slug>/` 记录切换并迁移至 `https://env-<16hex>.example.com:8443`。
   - `tunnelHub` 在 WebSocket `101` 握手响应头透传 `X-Tunnel-Public-Host` / `X-Tunnel-Public-Url`，由 `t3RelayTunnelClient` 回传给 `ManagedEndpointRuntime`、`ConnectReachability` 与 `mcpOAuthHttp`，解锁 **访客链接**、**MCP OAuth (`Use in another app`)**、**跨网关联环境 (`PeerLinks`)** 与直接网页端远程接入。
   - **反向代理要求**：除主域名（如 `connect.example.com`）外，新增泛域名规则 `*.example.com`（端口 `:8443`，HTTPS TLS 证书覆盖 `*.example.com`），后端同样转发到 `http://127.0.0.1:8787` 且保留原始 `Host` 头，并确保 `GET /.well-known/t3/*`、`POST /oauth/*`、`GET /v1/tunnels/*` 等所有路由直接反代至容器。
2. **管理员受管隧道限额与功能权限（无付费/无云模型）**
   - `users` 表新增 `max_tunnels`（默认 `DEFAULT_USER_MAX_TUNNELS=3`）与 `permissions_json`（`managedTunnels`、`webhooks`、`mobilePush`）。
   - 超管可通过 `/admin`（与 `/api/admin/users/:userId`）实时调整每账号隧道上限与三项功能权限，不接入 T3 Chat 付费或云模型订阅；超限创建新隧道时返回标准错误码 `403 environment_link_limit_exceeded`。
3. **定时任务 Webhook 中继与离线暂存队列**
   - 开放 `ALL /v1/hooks/:endpointKey/:hookId/:token` 转发外网 Webhook 至对应受管环境，并附带 `EdDSA` 签名的 `x-t3-relay-delivery`（`typ: t3-relay-hook-delivery+jwt`）。
   - 环境离线时自动写入 `held_webhooks` 表（24 小时 TTL），待环境发送 `POST /v1/environments/:environmentId/hooks/wake` 或隧道重连时自动批量重放；重放失败或未成功时清理过期/完成投递并控制重试次数。
4. **移动端 Agent 感知与原生推送调度**
   - `POST /v1/environments/:environmentId/threads/:threadId/agent-activity` 验证 `EdDSA` 证明（`typ: t3-env-activity+jwt`），持久化 `agent_activities` / `live_activities`，并在需要人工审批、等待输入、任务完成或失败时经零依赖 `pushDispatcher.ts` 调度发送：
     - iOS APNs（HTTP/2 + ES256 `.p8`，支持常规 Alert 与 iOS 18+ Live Activity）
     - Android FCM HTTP v1（RS256 Service Account OAuth2）
     - Expo Push API 兜底（当设备持有 `ExponentPushToken[...]` 时）
   - 若部署环境暂未配置 `APNS_*` / `FCM_*`，服务端仅持久化状态与 Expo 令牌，不崩溃也不影响 `/v1/mobile/agent-activity` 轮询聚合。
5. **WebSPA 一体化托管（`WEB_DIST_DIR=/app/web-dist`）与自助安全设置**
   - Docker 镜像同时内置构建好的 `apps/web/dist`，在主站点根路径（如 `https://connect.example.com:8443`）直接服务 `/`, `/pair`, `/approve-agent`, `/assets/*`，支持访客链接打开与 OAuth 回跳。
   - `/login` 门户、Web 账号弹窗（新增「账号与配额」标签页）与 Mobile `LunaMobileAuthScreen` 均支持查看隧道配额与权限、修改昵称、修改登录密码以及一键注销其他设备会话。
