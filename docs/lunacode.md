# LunaCode Features & Fork Guide

<p>
  <strong>English</strong> · <a href="./lunacode.zh-CN.md">简体中文</a>
</p>

> **Upstream attribution:** **LunaCode** ([`nidao003/lunacode`](https://github.com/nidao003/lunacode)) is an open-source fork of [**T3 Code (`pingdotgg/t3code`)**](https://github.com/pingdotgg/t3code) by T3 Tools Inc. (MIT License).

LunaCode preserves upstream T3 Code's multi-provider orchestration engine, remote architecture, and `~/.t3/userdata` database schema while adding privacy-by-default telemetry settings, a zero-dependency self-hosted Docker backend + `"t3_relay"` tunnel (`nidao008/lunacode-connect`), runtime backend server URL configuration, official-ToS-compliant quota/account tooling, cross-surface context & cache observability, explicit approval confirmation cards, read-only repo git history, LAN `.local` mDNS pairing, Antigravity media/session hardening, and a declarative `*.flow.json` visual DAG workflow studio across Web/Desktop and Mobile.

---

## 1. Branch Model & Coexistence with Official T3 Code (`LUNA-001`, `LUNA-002`)

- **Branch topology:**
  - `main`: Read-only automated mirror of `upstream/main` (synced by GitHub Actions). Do not commit custom work to `main`.
  - `lunacode`: Primary development and release branch for all LunaCode features and adaptations.
  - Upstream merges follow the SOP in [`AGENTS.fork.md`](../AGENTS.fork.md#2-定期合并上游标准流程upstream-merge-sop).
- **Side-by-side macOS installation:**
  - Builds with bundle ID `com.nidao003.lunacode` (mobile: `com.nidao003.lunacode.mobile`), isolated Electron `userData` (`lunacode-v2`), Chang'e moon-themed icons (`assets/lunacode/`), and `electron-updater` pointed to `nidao003/lunacode` (`LUNA-019`).
  - Both Official `T3 Code (Beta).app` and `LunaCode.app` share `~/.t3/userdata` safely. If the official app holds the home directory lock on launch, LunaCode detects it and offers a guided prompt to close the official app cleanly before starting.

---

## 2. Privacy & Telemetry Defaults (`LUNA-012`)

Unlike upstream T3 Code, LunaCode ships with external telemetry and crash reporting **off by default**:

- **Server product analytics:** Disabled by default in [`AnalyticsService.ts`](../apps/server/src/telemetry/AnalyticsService.ts) (`T3CODE_TELEMETRY_ENABLED=false`). Set `T3CODE_TELEMETRY_ENABLED=true` explicitly to opt back in.
- **Mobile crash reporting:** `expo-observe` relay crash reporting is disabled in [`observe.ts`](../apps/mobile/src/features/observability/observe.ts).
- **Mobile OTLP tracing:** Default upstream Axiom tracing is disabled in [`tracing.ts`](../apps/mobile/src/features/observability/tracing.ts) unless you explicitly configure `EXPO_PUBLIC_OTLP_TRACES_TOKEN`.

---

## 3. Self-Hosted Backend (`lunacode-connect`) & Remote Access (`LUNA-017`)

Upstream T3 Code couples cloud login and remote relays to Clerk (`clerk.t3.codes`) and Cloudflare Workers/Zero Trust. LunaCode replaces that dependency with an open-source, self-hostable container:

- **All-in-one Docker backend (`services/lunacode-connect/`):** Zero external npm dependencies (`Node 22` + `node:sqlite`), published multi-arch on Docker Hub as [`nidao008/lunacode-connect`](https://hub.docker.com/r/nidao008/lunacode-connect) (`linux/amd64` + `linux/arm64`). Includes:
  - Email/password authentication + cookie/Bearer sessions + EdDSA (Ed25519) JWT & JWKS
  - OAuth2 PKCE + `/connect` portal + Device Code flows for CLI
  - Relay v1 control plane (`DPoP`, link challenges, `t3_relay` tunnel hub)
  - Webhook relay (`/v1/hooks/...`) with 24h offline hold & auto-replay queue
  - Agent Awareness & native push dispatcher (APNs HTTP/2 + iOS Live Activities, Android FCM HTTP v1, Expo Push fallback)
  - Optional bundled Web SPA (`WEB_DIST_DIR=/app/web-dist`) and live `/admin` super-admin console (quotas, permissions, allowlist, device/session management)
- **Single-domain & Wildcard tunnel routing:** Works on standard or custom HTTPS ports (e.g. `:8443`) using either `/t/<slug>/` path prefix routing (one domain + one cert) or wildcard subdomain routing (`env-<16hex>.example.com:port`, unlocking Guest Links, MCP OAuth, and PeerLinks).
- **Zero hardcoded private domains & Runtime URL Switcher:**
  - Public builds emit `LUNACODE_SELF_HOSTED_AUTH=1` with **no pre-baked private domain**.
  - Desktop, Web, and Mobile provide a built-in server URL configuration card (in the Sign In dialog, Account dialog, Web Settings → Labs → LunaCode, and Mobile Settings → Server/Account) persisted across launches. Switching URLs clears stale sessions cleanly and updates Electron's dynamic `Origin`/CORS whitelist via IPC (`luna:set-auth-url`).
- **Automatic LAN switchback:** Clients use `t3_relay` HTTPS/WSS when remote and automatically switch back to direct LAN IP or `.local` mDNS endpoints (`ROUTE_KIND_RANK.lan = 1 < relay = 5`) on Desktop and Mobile upon returning to the local network.
- See [`../services/lunacode-connect/README.md`](../services/lunacode-connect/README.md) for deployment & image build commands and [`./lunacode-connect-plan.md`](./lunacode-connect-plan.md) for full protocol architecture.

---

## 4. Web & Mobile Productivity & UX Additions

Core algorithms live in `packages/client-runtime/src/lunacode/` and render natively across Web/Desktop (`apps/web/src/lunacode/`) and iOS/Android (`apps/mobile/src/lunacode/`).

### Context Telemetry Bar, Turn Speed & Context Inspector (`LUNA-003`, `LUNA-004`)

- **Zero extra LLM calls:** Computed strictly from local turn usage metadata.
- **Footer bar:** Shows live context window usage, warning threshold marker, prompt cache hit rate, cache TTL countdown, and average output speed (`tok/s`).
- **Context & Cache Inspector:** Interactive modal showing thresholds, cache attribution, API-equivalent cost estimate, per-turn latency/speed, and context composition.

### Structured `/compact` Templates & Deterministic Handoff (`LUNA-005`)

- **Structured `/compact` templates (opt-in, off by default):** Appends structured formatting rules when enabled without altering upstream behavior by default.
- **Deterministic handoff:** Generates a structured summary draft from local state into a new thread without hidden LLM calls.

### Approval Confirmation Card & Read-Only Git History (`LUNA-018`, `LUNA-016`)

- **Composer approval confirmation card (`LUNA-018`):** Restores a single prominent approval banner directly above the composer input with expanded localized Allow / Allow for Session / Deny / Cancel controls while suppressing duplicate timeline cards when the composer owns approval.
- **Read-only repository Git history (`LUNA-016`):** Paginated commit history across repository refs plus commit detail inspection on Web DiffPanel and Mobile GitOverview (`ReviewService` cwd-scoped read-only queries, zero write operations).

### LAN `.local` mDNS Discovery & Custom Domain Pairing (`LUNA-010`)

- Enabling **Network access** on macOS Desktop automatically reads `LocalHostName` and advertises `http://<host>.local:<port>/`.
- **Settings → Sharing & access** lets you switch pairing URLs and QR codes between LAN IP, `.local` hostname, and any custom LAN domain without restarting the server.

### Terminal Output Noise Reduction (`rtk`) (`LUNA-007`)

- Opt-in helper in Desktop Settings that checks for local [`rtk`](https://github.com/rtk-ai/rtk) and native Claude Code hooks without mutating tool output silently.

### Visual Workflow Studio (`*.flow.json`) (`LUNA-020`)

- **Coexists with upstream `.ts` / `.js` workflows:** Adds declarative `*.flow.json` (`FlowSpec` v1) execution alongside upstream programmatic workflows, supporting parallel fan-out/fan-in DAG stages, bounded `isLoop` + `maxHops` human approval circuit breakers, zero-token `precheck` gate scripts, `<untrusted_event_data>` isolation, and same-project concurrent `root` write conflict validation.
- **8 curated templates (6 auto-seeded on first run):** Auto-seeds 6 `manual` templates once per installation via `.lunacode-flow-presets.json` (`bug-repro-fix`, `pr-dual-review`, `ci-doctor-autofix`, `docs-drift-sync`, `release-notes-prep`, `daily-repo-standup`), plus on-demand `issue-triage` and `feature-plan-ship`.
- **Cross-surface orchestration & MCP:** Exposes the `workflows.start` RPC and in-thread `t3_flow_*` MCP tools (supporting versioned `vN+1` flows), paired with an interactive Web/Desktop DAG canvas + live run viewer and a Mobile vertical stage studio.

---

## 5. Multi-Account Setup, Quotas & Compliance (`LUNA-006`, `LUNA-008`, `LUNA-009`, `LUNA-011`, `LUNA-013`)

- **Strict official CLI/ACP compliance (`LUNA-011`):** Zero MITM proxying, zero Keyring/OAuth scraping, zero hardcoded OAuth secrets, zero UA spoofing, and zero background `TextGeneration` calls on personal subscriptions.
- **Isolated account helper & per-account quota cards (`LUNA-006`):** Guides creation of isolated config homes (manual switching only, never auto-rotates) and displays per-account quota windows, upstream tier badges, and sibling comparisons.
- **Kimi Code quota integration (`LUNA-009`):** Reads `{KIMI_CODE_HOME:-~/.kimi-code}/credentials/kimi-code.json` (`/me` & `/usages`) with POSIX file locking, Windows read-only protection, a 5-minute TTL cache, and `turn.agent_busy` steering/retry guards.
- **Antigravity quota & session recovery (`LUNA-011`, `LUNA-013`):** Refreshes quotas strictly on manual **Refresh** via isolated `agy --print /usage --output-format json` (5-min cooldown + offline cache). Validates image/audio attachments before sending (rejecting empty files and Apple `CgBI` PNGs) and recovers automatically from `INVALID_MEDIA_INPUT` errors on the next turn.
- **OpenViking memory (`LUNA-008`, retired):** Handled exclusively by each agent CLI's native OpenViking plugin configured in `~/.openviking/ovcli.conf` to avoid duplicate injection or mismatched search thresholds.

---

## 6. Building Locally

```bash
# Install dependencies (from the lunacode branch)
vp i

# Start server + web dev environment
vp run dev

# Build locally signed macOS arm64 DMG
bash .claude/skills/lunacode-mac-dmg/scripts/build-signed-dmg.sh

# Build multi-arch lunacode-connect Docker image
bash services/lunacode-connect/scripts/build-image.sh --load
```

For mobile builds (iOS & Android), see [`apps/mobile/README.md`](../apps/mobile/README.md) and [`docs/operations/00_development.md`](./operations/00_development.md).
