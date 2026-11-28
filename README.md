<p align="center">
  <img src="./assets/lunacode/lunacode-web-icon-192x192.png" width="88" height="88" alt="LunaCode Chang'e icon" />
</p>

<h1 align="center">LunaCode</h1>

<p align="center">A privacy-first, self-hostable, multi-surface control plane for coding agents — forked from <a href="https://github.com/pingdotgg/t3code">T3 Code</a>.</p>

<p align="center">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="#lunacode-vs-upstream-t3-code">LunaCode vs. Upstream</a> ·
  <a href="#self-hosted-backend-deployment-docker">Backend Deployment (Docker)</a> ·
  <a href="#connecting-clients-to-your-backend">Client Setup</a> ·
  <a href="#build--install-from-source">Build from Source</a> ·
  <a href="./docs/lunacode.md">LunaCode Guide</a> ·
  <a href="./services/lunacode-connect/README.md">Connect Backend Docs</a>
</p>

> **Fork Notice:** **LunaCode** ([`nidao003/lunacode`](https://github.com/nidao003/lunacode)) is an independent open-source fork of [**T3 Code**](https://github.com/pingdotgg/t3code) by T3 Tools Inc. (MIT License). `main` is a read-only mirror of `upstream/main`; all LunaCode enhancements live on the [`lunacode`](https://github.com/nidao003/lunacode/tree/lunacode) branch and maintain full database compatibility with `~/.t3/userdata`.

LunaCode runs the coding agents already installed on your machine and unifies them across **Desktop**, **Web**, and **Mobile (iOS & Android)**. It supports Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, Kimi Code, and any [ACP](./docs/user/providers-acp.md) agent using your own subscriptions and credentials.

---

## LunaCode vs. Upstream T3 Code

### Side-by-Side Comparison

| Area                                   | Upstream T3 Code (`pingdotgg/t3code`)                     | LunaCode (`nidao003/lunacode`)                                                                                                                                                                                                                             |
| -------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **App Identity & Data Coexistence**    | `T3 Code` bundle ID, `userData`, and single-instance lock | Independent `LunaCode` branding & Chang'e artwork (`com.nidao003.lunacode` / `com.nidao003.lunacode.mobile`), isolated `lunacode-v2` userData, dual-launch guard alongside official `T3 Code (Beta).app`, shared `~/.t3/userdata`                          |
| **Telemetry & Crash Reporting**        | PostHog analytics, mobile Observe & Axiom OTLP enabled    | **Disabled by default** (`T3CODE_TELEMETRY_ENABLED=false`, Observe disabled, Axiom requires explicit opt-in token)                                                                                                                                         |
| **Cloud Auth & Remote Tunnel Backend** | Clerk (`clerk.t3.codes`) + Cloudflare Workers/Zero Trust  | **Self-hosted all-in-one Docker backend** (`nidao008/lunacode-connect`) using Node 22 + `node:sqlite`, OAuth2 PKCE/Device Code, Relay v1, built-in binary WS `"t3_relay"` tunnel, `/admin` console, webhook queue & push dispatcher                        |
| **Client Backend Configuration**       | Build-time hosted URL                                     | **Zero hardcoded private domains** in public builds; runtime server URL switcher UI across Desktop, Web, and Mobile                                                                                                                                        |
| **Remote + LAN Routing**               | Relay or manual setup                                     | Public access via `t3_relay` HTTPS/WSS + automatic LAN return (`ROUTE_KIND_RANK.lan = 1`), `.local` mDNS discovery (`scutil --get LocalHostName`), custom LAN domain pairing UI                                                                            |
| **Context & Cache Observability**      | Basic context meter                                       | Zero-token footer bar (context window, warning threshold, cache hit %, TTL countdown, `tok/s`), detailed Context & Cache Inspector (`Web` & `Mobile`)                                                                                                      |
| **Compaction & Handoff**               | Standard `/compact`                                       | Optional opt-in structured `/compact` template + deterministic zero-LLM thread handoff draft                                                                                                                                                               |
| **Approvals & Git History**            | Inline approval log / diff view                           | Prominent single composer approval confirmation card (direct Allow / Session / Deny / Cancel controls) + read-only repo-wide commit history & diff inspector (`Web` & `Mobile`)                                                                            |
| **Visual Workflow Studio**             | Programmatic `.ts` / `.js` workflow definitions           | Declarative `*.flow.json` DAG canvas on Desktop/Web + vertical stages on Mobile (`LUNA-020`), 8 starter templates (6 auto-seeded `manual` cases), zero-token `precheck`, bounded loop human circuit breaker, `workflows.start` RPC & `t3_flow_*` MCP tools |
| **Multi-Account & Quota Compliance**   | Pooled usage / standard flows                             | Isolated manual multi-account wizard, per-account quota breakdown & tier badges, Kimi Code POSIX-locked quota reader, Antigravity ToS-compliant CLI quota & `CgBI`/broken-session recovery                                                                 |
| **Update & CI Distribution**           | `pingdotgg/t3code` Releases                               | Dedicated `nidao003/lunacode` GitHub Releases (`electron-updater`, CLI/Server update, Mobile checker) + automated multi-arch Docker Hub releases (`linux/amd64`, `linux/arm64`)                                                                            |

### Detailed Feature Breakdown

All customizations are indexed in [`AGENTS.fork.md`](./AGENTS.fork.md#5-二开定制清单customizations-ledger) (`LUNA-001`–`LUNA-020`) and detailed in the [LunaCode Guide](./docs/lunacode.md):

1. **Independent Identity, Chang'e Artwork & Safe Coexistence (`LUNA-001`, `LUNA-002`)**
   - Ships with independent macOS/Windows/Linux bundle ID (`com.nidao003.lunacode`) and mobile bundle ID (`com.nidao003.lunacode.mobile`), moon-themed icons (`assets/lunacode/`), and isolated `lunacode-v2` Electron state.
   - Shares `~/.t3/userdata` safely with official `T3 Code (Beta).app` and offers a one-click guided handoff if the official app already holds the directory lock.
2. **Privacy by Default (`LUNA-012`)**
   - PostHog product telemetry defaults to off (`T3CODE_TELEMETRY_ENABLED=false`), mobile Observe crash reporting is disabled, and OTLP tracing stays off unless explicitly configured.
3. **Self-Hosted Backend (`lunacode-connect`), `"t3_relay"` Tunnel & Runtime Server Switcher (`LUNA-017`)**
   - Replaces Cloudflare Workers + Clerk with a zero-dependency Node 22 + `node:sqlite` container ([`services/lunacode-connect/`](./services/lunacode-connect/)) published to Docker Hub (`nidao008/lunacode-connect`).
   - Built-in binary multiplexed WebSocket `"t3_relay"` tunnel supports both **single-domain path prefix** (`https://your-host:port/t/<slug>/`, needing only one TLS cert) and **wildcard subdomain** (`https://env-<16hex>.example.com:port/`, unlocking Guest Links, MCP OAuth, and PeerLinks).
   - Desktop and Mobile automatically reconnect over direct LAN IP / `.local` mDNS when back on the same local network (`ROUTE_KIND_RANK.lan = 1 < relay = 5`).
   - Public binaries ship with **no hardcoded backend domain**; users enter and switch their own `lunacode-connect` HTTPS URL directly inside Desktop, Web, or Mobile.
4. **Local Context Telemetry, Cache Inspector & Turn Speed (`LUNA-003`, `LUNA-004`, `LUNA-005`)**
   - Live context footer bar (`tok/s`, warning marker, cache hit rate, TTL countdown) and Context & Cache Inspector dialog across Web, Desktop, and Mobile — computed with zero extra LLM calls.
   - Optional structured `/compact` template and deterministic "compact & continue in new thread" draft handoff.
5. **Explicit Approval Banner & Read-Only Git History (`LUNA-016`, `LUNA-018`)**
   - Restores a clear, single composer approval banner above the input box (avoiding duplicate timeline + composer cards) with localized action buttons.
   - Adds read-only repository-wide branch/tag/commit history browsing and commit detail inspection on Web and Mobile.
6. **Multi-Account Isolation, Provider Quota Cards & ToS Compliance (`LUNA-006`, `LUNA-009`, `LUNA-011`, `LUNA-013`)**
   - Manual-only multi-account isolation setup helper and per-account quota cards/tier badges in the model picker and sidebar.
   - Strict official-CLI compliance (zero Keyring extraction, zero private API scraping, zero hidden background LLM turns on personal subscriptions), Kimi Code POSIX-locked quota reader, Antigravity manual refresh with offline cache, and pre-send `CgBI` / media validation with auto session recovery.
7. **LAN `.local` mDNS Discovery, `rtk` Helper & Dedicated Update Channels (`LUNA-007`, `LUNA-010`, `LUNA-019`)**
   - Broadcasts `.local` mDNS endpoints automatically when network access is enabled and supports switching pairing QR/links between LAN IP, `.local`, and custom domains without restarting.
   - Optional `rtk` status/hook helper in Settings (`LUNA-007`).
   - Routes Desktop `electron-updater`, CLI/Server self-updates, install scripts, and Mobile version checks to `nidao003/lunacode`.
8. **Human-in-the-Loop Visual Workflow Studio (`LUNA-020`)**
   - Declarative `*.flow.json` (`FlowSpec` v1) DAG orchestration with parallel fan-out/fan-in, bounded `isLoop` + `maxHops` human approval gates, zero-token `precheck` scripts, `<untrusted_event_data>` isolation, and same-project concurrent `root` write guards alongside upstream `.ts`/`.js` workflows.
   - Ships 8 curated templates (with 6 `manual` templates auto-seeded once per installation via `.lunacode-flow-presets.json`), `workflows.start` RPC, `t3_flow_*` MCP tools, interactive Web/Desktop DAG canvas + live run tracker, and a synced Mobile vertical stage studio.

---

## Self-Hosted Backend Deployment (`Docker`)

LunaCode provides a complete, self-hosted backend (`@lunacode/connect`) in [`services/lunacode-connect/`](./services/lunacode-connect/) with zero external database or runtime npm dependencies. Multi-arch images (`linux/amd64` + `linux/arm64`) are published automatically to Docker Hub:

- **Docker Hub Repository:** [`nidao008/lunacode-connect`](https://hub.docker.com/r/nidao008/lunacode-connect)

### Method 1: Quick Deploy from Docker Hub (Recommended)

```bash
# 1. Clone (or copy services/lunacode-connect/ files to your server)
git clone -b lunacode --depth 1 https://github.com/nidao003/lunacode.git
cd lunacode/services/lunacode-connect

# 2. Create and edit environment variables
cp .env.example .env
# IMPORTANT: Edit .env and set at least:
#   PUBLIC_ORIGIN=https://connect.example.com:8443
#   TUNNEL_PUBLIC_PORT=8443
#   ADMIN_EMAILS=admin@example.com
$EDITOR .env

# 3. Pull multi-arch image and start container (includes healthcheck)
bash scripts/deploy.sh --pull
```

Or run directly with Docker Compose:

```bash
docker pull nidao008/lunacode-connect:latest
docker compose up -d
curl -fsS http://127.0.0.1:8787/health
```

### Method 2: Build Your Own Docker Image / Offline Tarball

If you prefer building from source or deploying to an air-gapped server, use [`services/lunacode-connect/scripts/build-image.sh`](./services/lunacode-connect/scripts/build-image.sh):

```bash
# A. Build locally and load into Docker for testing (builds Web SPA + container automatically)
bash services/lunacode-connect/scripts/build-image.sh --load

# B. Export an offline linux/amd64 .tar.gz archive for manual server upload
bash services/lunacode-connect/scripts/build-image.sh \
  --platform linux/amd64 \
  --tag lunacode-connect:0.1.13 \
  --export-tar ./lunacode-connect-0.1.13-linux-amd64.tar.gz

# Import and start on the target server:
bash services/lunacode-connect/scripts/deploy.sh --tar ./lunacode-connect-0.1.13-linux-amd64.tar.gz

# C. Build & push a multi-arch image (amd64 + arm64) to your own Docker Hub repo
docker login -u <your-dockerhub-username>
bash services/lunacode-connect/scripts/build-image.sh \
  --platform linux/amd64,linux/arm64 \
  --tag <your-dockerhub-username>/lunacode-connect:latest \
  --tag <your-dockerhub-username>/lunacode-connect:0.1.13 \
  --push
```

### Method 3: Automated Multi-Arch Push via GitHub Actions

[`.github/workflows/lunacode-release.yml`](./.github/workflows/lunacode-release.yml) includes a `docker_connect_image` job that builds and pushes `linux/amd64,linux/arm64` images on every `lunacode-v*` release tag or `workflow_dispatch`:

1. Create a Docker Hub **Read, Write & Delete** (or Read & Write) Personal Access Token in Docker Hub Account Settings.
2. Add two repository secrets in GitHub (`Settings -> Secrets and variables -> Actions -> Secrets`):
   - `DOCKERHUB_USERNAME`: your Docker Hub username (e.g. `nidao008`)
   - `DOCKERHUB_TOKEN`: your Docker Hub PAT
3. Tags pushed automatically: `<DOCKERHUB_USERNAME>/lunacode-connect:latest` and `<DOCKERHUB_USERNAME>/lunacode-connect:<version>`.

### Reverse Proxy & HTTPS Setup

Place Nginx, Caddy, 1Panel, Lucky, or another TLS reverse proxy in front of container port `8787`:

- Preserve non-443 ports in the `Host` header (Nginx: `proxy_set_header Host $http_host;`, **not** `$host`).
- Forward `X-Forwarded-Proto $scheme`, `Upgrade $http_upgrade`, and `Connection $connection_upgrade`.
- Disable proxy buffering (`proxy_buffering off;`) and raise timeouts (`proxy_read_timeout 3600s;`).
- See ready-to-use templates: [`nginx.conf.example`](./services/lunacode-connect/nginx.conf.example) and [`Caddyfile.example`](./services/lunacode-connect/Caddyfile.example), plus full details in [`services/lunacode-connect/README.md`](./services/lunacode-connect/README.md).

### Super-Admin Console (`/admin`) & First Account

- On first boot against a fresh SQLite DB, set `ADMIN_EMAILS=admin@example.com` in `.env` (or the earliest registered user on an upgraded legacy database is promoted automatically).
- Visit `https://<your-public-origin>/admin` after signing in to toggle open registration, manage allowlists, adjust user `maxTunnels` quotas and capability permissions, reset passwords, or revoke active sessions/devices.

---

## Connecting Clients to Your Backend

Public LunaCode desktop, web, and mobile builds intentionally ship with **no hardcoded backend domain**. Configure your server URL at runtime in any of these places:

- **Desktop / Web:**
  - Top of the **Sign In / Register** modal (`LunaServerUrlConfigCard`)
  - Bottom of the **Account & Remote Devices** modal
  - **Settings → Labs → LunaCode Custom Features → 后台登录与中继服务地址**
- **Mobile (iOS & Android):**
  - **Settings → Server / Account (连接/登录账号) → 后台登录与中继地址**

Enter your HTTPS backend origin (e.g., `https://connect.example.com:8443`, without path or query parameters) and tap **Save & Switch**. Desktop automatically updates its Electron CORS whitelist via IPC (`luna:set-auth-url`) and clears sessions from the previous backend.

> If you build custom binaries for a team and want a pre-filled default URL, set `LUNACODE_CONNECT_URL=https://connect.example.com:8443` in root `.env` or as a GitHub Actions Repository Variable (`vars.LUNACODE_CONNECT_URL`). Setting `LUNACODE_CONNECT_URL=off` disables self-hosted auth completely.

---

## Design Principles & Guardrails

1. **Official Subscription Compliance:** No traffic MITM, no Keyring/token scraping, no client spoofing, no background keep-alive probes, and no automatic multi-account rotation pools.
2. **Zero Hidden Token Spend:** Context telemetry, cache stats, cost estimation, and handoff assembly are 100% deterministic local computations.
3. **Zero Context Degradation:** System prompts, reasoning effort, tool definitions, and error stack traces are never silently altered or truncated.
4. **Upstream Data Compatibility:** Preserves `~/.t3/userdata/statev2.sqlite` schemas so you can switch freely between official T3 Code and LunaCode at any time.

---

## Build & Install from Source

> **Branch model:** Always work on `lunacode` (never commit directly to `main`, which mirrors `upstream/main`). See [`AGENTS.fork.md`](./AGENTS.fork.md).

```bash
git clone -b lunacode https://github.com/nidao003/lunacode.git
cd lunacode
vp i
```

### Run Desktop & Web in Development

```bash
vp run dev
```

### Build Locally Signed macOS Desktop DMG (`arm64`)

```bash
bash .claude/skills/lunacode-mac-dmg/scripts/build-signed-dmg.sh
```

Outputs `release/LunaCode-<version>-arm64.dmg` signed with your local Xcode `Apple Development` identity (or pass `--unsigned`).

### Build Mobile (iOS & Android)

See [`apps/mobile/README.md`](./apps/mobile/README.md) and [`docs/operations/00_development.md`](./docs/operations/00_development.md).

---

## Documentation

- [简体中文 README](./README.zh-CN.md)
- [LunaCode Features & Fork Guide](./docs/lunacode.md) ([简体中文](./docs/lunacode.zh-CN.md))
- [lunacode-connect Backend Deployment & Packaging](./services/lunacode-connect/README.md) ([简体中文](./services/lunacode-connect/README.zh-CN.md))
- [lunacode-connect Architecture Plan](./docs/lunacode-connect-plan.md)
- [Fork Workflow & Customizations Ledger (`AGENTS.fork.md`)](./AGENTS.fork.md)
- [All Docs Index](./docs/README.md)

---

## Upstream Attribution & License

LunaCode is forked from [**T3 Code (`pingdotgg/t3code`)**](https://github.com/pingdotgg/t3code), created by Theo Browne, Julius Marminge, and T3 Tools Inc.

Licensed under the [MIT License](./LICENSE).

## Trademarks and forks

The MIT license applies **only to the source code**. It does not grant any rights to T3 Tools, Inc.'s trademarks, branding, or trade dress, including the **T3 Code** name, wordmark, logos, and application icons. See [TRADEMARK.md](./TRADEMARK.md).
