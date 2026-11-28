# `@lunacode/connect` — 自建后端与中继服务部署指南

<p>
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

零外部数据库、零第三方 npm 依赖的一体化后端容器服务（基于 Node.js 22 + 内置 `node:sqlite`），为你自己的服务器提供完整可靠的远程账号、公网中继、移动推送与网页托管能力：

- **账号与安全管理**：邮箱密码注册/登录、长效 Session、EdDSA（Ed25519）JWT 与 JWKS（`/.well-known/jwks.json`），以及全端自助修改昵称、改密和注销其他设备会话。
- **OAuth2 与 CLI 授权**：兼容 OAuth2 PKCE 浏览器回调（`/oauth/authorize`、`/connect`）和无头终端/SSH 的 Device Code 设备码流程（`/oauth/device/code`）。
- **Relay v1 控制面**：完整兼容 `@t3tools/contracts/relay`（`DPoP` 证明签发、绑定 Challenge、在线探测与凭证签发）。
- **内置二进制多路复用 `"t3_relay"` 隧道网关**：无需安装 `cloudflared`、无需家庭公网开端口映射，本地宿主主动建立出站 WebSocket 隧道。支持两种模式：
  - **单域名路径前缀模式（默认）**：`https://<你的域名>[:端口]/t/<slug>/` — 只需 1 个域名和 1 张证书即可挂载任意多台电脑。
  - **通配符泛域名模式（可选）**：`https://env-<16hex>.<泛域名根>[:端口]/` — 完整解锁访客链接（Guest Links）、MCP OAuth（`Use in another app`）与跨网关联环境（PeerLinks）。
- **Webhook 中继与原生推送**：开放 `/v1/hooks/:endpointKey/:hookId/:token`（环境离线自动暂存 24 小时并在上线后自动重放），集成 iOS APNs HTTP/2（常规提醒 + Live Activity）、Android FCM HTTP v1 与 Expo Push 兜底。
- **内置 Web SPA 与 `/admin` 超管控制台**：托管打包好的前端静态资源（`WEB_DIST_DIR=/app/web-dist`），提供 `/login`、`/admin`、`/pair`、`/approve-agent`，并可在 `/admin` 动态调整用户隧道配额（`maxTunnels`）和权限开关（`managedTunnels` / `webhooks` / `mobilePush`）。

---

## 1. 直接拉取 Docker Hub 官方镜像（推荐）

官方双架构镜像（`linux/amd64` + `linux/arm64`）已托管至 Docker Hub：

```bash
docker pull nidao008/lunacode-connect:latest
# 或指定具体版本：
docker pull nidao008/lunacode-connect:0.1.13
```

### 快速启动步骤

```bash
cd services/lunacode-connect
cp .env.example .env
```

编辑 `.env` 填入你自己的公网域名、端口与管理员邮箱：

```dotenv
LUNACODE_BIND_HOST=0.0.0.0
LUNACODE_HOST_PORT=8787

PUBLIC_ORIGIN=https://connect.example.com:8443
TUNNEL_BASE_SCHEME=https
TUNNEL_PUBLIC_PORT=8443

# 单域名 /t/<slug>/ 模式请留空；如需泛域名子域模式可填写如 example.com
TUNNEL_WILDCARD_DOMAIN=

ALLOW_REGISTRATION=true
ADMIN_EMAILS=admin@example.com
```

一键部署并验证健康检查：

```bash
bash scripts/deploy.sh --pull
# 或手动执行：
# docker compose up -d
# curl -fsS http://127.0.0.1:8787/health
```

日常运维常用命令：

```bash
bash scripts/deploy.sh --logs   # 实时查看容器日志
bash scripts/deploy.sh --down   # 停止容器（自动保留数据卷 /data）
```

---

## 2. 自行构建镜像、导出离线包与推送 Docker Hub

项目已内置一键构建脚本 [`scripts/build-image.sh`](./scripts/build-image.sh)，会自动编译 `apps/web` 前端 SPA、打包进入容器并自动清理临时目录。

### A. 本机源码构建并加载到本地 Docker

```bash
bash services/lunacode-connect/scripts/build-image.sh --load
```

### B. 导出离线 `.tar.gz` 镜像包（适合内网/无加速环境手动上传）

```bash
bash services/lunacode-connect/scripts/build-image.sh \
  --platform linux/amd64 \
  --tag lunacode-connect:0.1.13 \
  --export-tar ./lunacode-connect-0.1.13-linux-amd64.tar.gz
```

将 `.tar.gz` 与 `services/lunacode-connect/` 上传到服务器后导入启动：

```bash
bash services/lunacode-connect/scripts/deploy.sh --tar ./lunacode-connect-0.1.13-linux-amd64.tar.gz
```

（或者先 `docker load -i lunacode-connect-0.1.13-linux-amd64.tar.gz`，在 `.env` 配置 `LUNACODE_CONNECT_IMAGE=lunacode-connect:0.1.13` 后 `docker compose up -d`。）

### C. 本地跨架构编译并推送到你自己的 Docker Hub

```bash
# 1. 登录 Docker Hub（Password 处填入 Docker Hub Personal Access Token）
docker login -u <你的DockerHub用户名>

# 2. 编译 linux/amd64 + linux/arm64 双架构镜像并推送
bash services/lunacode-connect/scripts/build-image.sh \
  --platform linux/amd64,linux/arm64 \
  --tag <你的DockerHub用户名>/lunacode-connect:latest \
  --tag <你的DockerHub用户名>/lunacode-connect:0.1.13 \
  --push
```

检查已推送的镜像架构清单：

```bash
docker buildx imagetools inspect <你的DockerHub用户名>/lunacode-connect:latest
```

### D. GitHub Actions 自动推送 Docker Hub 镜像

仓库的 [`.github/workflows/lunacode-release.yml`](../../.github/workflows/lunacode-release.yml) 已内置 `docker_connect_image` 作业。在 GitHub 仓库 `Settings -> Secrets and variables -> Actions -> Secrets` 配置 `DOCKERHUB_USERNAME` 与 `DOCKERHUB_TOKEN` 后，每次发版或手动运行工作流均会自动将双架构镜像推送至你的 Docker Hub。

---

## 3. 反向代理与 HTTPS 配置（Nginx / Caddy / 1Panel / Lucky）

容器内监听 `8787` 端口（HTTP），公网入口由反向代理终结 TLS，务必注意以下 3 点：

1. **必须保留外网端口在 `Host` 头中**：Nginx 中务必配置 `proxy_set_header Host $http_host;`（**切勿使用 `$host`**，否则 `:8443` 等非标准端口会丢失导致 DPoP 与 OAuth 验签失败）。
2. **开启 WebSocket 透传并关闭代理缓冲**：转发 `X-Forwarded-Proto $scheme`、`Upgrade $http_upgrade`、`Connection $connection_upgrade`，并设置 `proxy_buffering off;` 及较长超时（`proxy_read_timeout 3600s;`）。
3. 如启用 `TUNNEL_WILDCARD_DOMAIN`，需同时把主域名（如 `connect.example.com`）与泛域名（`*.example.com` + 泛域名证书）反代到 `127.0.0.1:8787`。

现成模板可直接参考 [`nginx.conf.example`](./nginx.conf.example) 与 [`Caddyfile.example`](./Caddyfile.example)。

---

## 4. 环境变量完整说明

| 变量名                           | 默认值                 | 说明                                                                                                                |
| -------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `PORT`                           | `8787`                 | 容器内部监听 HTTP 端口                                                                                              |
| `DATA_DIR`                       | `/data`                | SQLite 数据库（`connect.sqlite`）与 Ed25519 密钥持久化目录                                                          |
| `WEB_DIST_DIR`                   | `/app/web-dist`        | 内置前端 Web SPA 静态文件目录                                                                                       |
| `PUBLIC_ORIGIN`                  | _（生产必填）_         | 公网 HTTPS 入口地址（如 `https://connect.example.com:8443`）                                                        |
| `TUNNEL_BASE_SCHEME`             | `https`                | 对外生成的隧道协议头                                                                                                |
| `TUNNEL_PUBLIC_PORT`             | 继承自 `PUBLIC_ORIGIN` | 对外生成的隧道 URL 端口                                                                                             |
| `TUNNEL_WILDCARD_DOMAIN`         | `""`                   | 泛域名根（如 `example.com` -> `env-<16hex>.example.com:8443`）；留空走单域名 `/t/<slug>/` 模式                      |
| `TUNNEL_SINGLE_DOMAIN`           | `""`                   | 可选独立单环境主机名，直接将该域名全部流量路由给单台环境                                                            |
| `DEFAULT_USER_MAX_TUNNELS`       | `3`                    | 新用户的默认隧道数量上限                                                                                            |
| `ALLOW_REGISTRATION`             | `true`                 | 是否允许公开注册（可在 `/admin` 动态切换）                                                                          |
| `ALLOWED_EMAILS`                 | `""`                   | 可选注册邮箱白名单（逗号分隔，可在 `/admin` 维护）                                                                  |
| `ADMIN_EMAILS`                   | `""`                   | 启动时自动提升为 `admin` 的管理员邮箱列表                                                                           |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `""`                   | 可选首次初始化创建的管理员账号与密码                                                                                |
| `CORS_ALLOWED_ORIGINS`           | `""`                   | 额外允许的跨域 Web 来源（逗号分隔）                                                                                 |
| `APNS_*` / `FCM_*`               | `""`                   | 可选 iOS APNs `.p8` 证书与 Android FCM 凭证。不配置时服务端跳过原生推送发送，不影响隧道、连接及客户端轮询状态感知。 |

---

## 5. 客户端接入与管理后台使用

1. 登录管理员账号后访问 `https://<你的公网地址>/admin`，即可在线修改注册策略、白名单、单用户隧道配额与功能开关，以及清理异常设备或强制踢下线。
2. 在 **LunaCode 桌面端、Web 端或移动端**打开登录弹窗顶部或设置页的「**后台登录与中继服务地址** / **后台登录与中继地址**」，输入 `https://<你的公网地址>` 并点击保存。
3. 在桌面/工作站端的「设置 → 环境与远程访问」关联本地服务并开启远程访问；移动/Web 客户端在外网自动走 HTTPS/WSS 隧道，回到同一局域网后自动切换为局域网直连。

---

## 6. 运行后端集成测试

```bash
node --experimental-strip-types --no-warnings --test test/connect.test.ts
```

完整协议设计与架构实现文档见 [`docs/lunacode-connect-plan.md`](../../docs/lunacode-connect-plan.md)。
