# LunaCode Features & Fork Guide

> **Upstream attribution:** **LunaCode** ([`nidao003/lunacode`](https://github.com/nidao003/lunacode)) is an open-source fork of [**T3 Code (`pingdotgg/t3code`)**](https://github.com/pingdotgg/t3code) by T3 Tools Inc. (MIT License).

LunaCode preserves upstream T3 Code's multi-provider orchestration engine, remote architecture, and `~/.t3/userdata` database schema while adding privacy-by-default telemetry settings, official-ToS-compliant quota/account tooling, cross-surface context & cache observability, OpenViking memory delegated to agent plugins, LAN `.local` mDNS pairing, and Antigravity media/session hardening.

---

## 1. Branch Model & Coexistence with Official T3 Code

- **Branch topology:**
  - `main`: Read-only automated mirror of `upstream/main` (synced by GitHub Actions). Do not commit custom work to `main`.
  - `lunacode`: Primary development and release branch for all LunaCode features and adaptations.
  - Upstream merges follow a version gate in [`AGENTS.fork.md`](../AGENTS.fork.md#2-定期合并上游标准流程upstream-merge-sop) using `git merge --no-ff origin/main`.
- **Side-by-side macOS installation (`LUNA-001`, `LUNA-002`):**
  - LunaCode builds with bundle ID `com.nidao003.lunacode` (mobile: `com.nidao003.lunacode.mobile`), isolated Electron `userData` (`lunacode-v2`), Chang'e moon-themed icons (`assets/lunacode/`), and no `app-update.yml` (official auto-updater disabled).
  - Both Official `T3 Code (Beta).app` and `LunaCode.app` share `~/.t3/userdata` safely. If the official app already holds the home directory lock on launch, LunaCode detects it and offers a guided prompt to close the official app cleanly before starting.

---

## 2. Privacy & Telemetry Defaults (`LUNA-012`)

Unlike upstream T3 Code, LunaCode ships with external telemetry and crash reporting **off by default**:

- **Server product analytics:** Disabled by default in [`AnalyticsService.ts`](../apps/server/src/telemetry/AnalyticsService.ts) (`T3CODE_TELEMETRY_ENABLED=false`). Set `T3CODE_TELEMETRY_ENABLED=true` explicitly if you want to opt back in.
- **Mobile crash reporting:** `expo-observe` relay crash reporting is disabled in [`observe.ts`](../apps/mobile/src/features/observability/observe.ts).
- **Mobile OTLP tracing:** Default upstream Axiom tracing is disabled in [`tracing.ts`](../apps/mobile/src/features/observability/tracing.ts) unless you explicitly provide `EXPO_PUBLIC_OTLP_TRACES_TOKEN`.

---

## 3. Web & Mobile Productivity Additions

Core algorithms are shared in `packages/client-runtime/src/lunacode/` and rendered natively on both Web/Desktop (`apps/web/src/lunacode/`) and iOS/Android (`apps/mobile/src/lunacode/`).

### Context Telemetry Bar, Turn Speed & Context Inspector (`LUNA-003`, `LUNA-004`)

- **Zero extra LLM calls:** Computed strictly from existing local turn usage metadata.
- **Footer status bar:** Displays live context window consumption, warning threshold marker, prompt cache hit percentage, cache TTL countdown, and average assistant output speed (`tok/s`).
- **Context & Cache Inspector:** Tap/click the footer bar to inspect capacity thresholds, cache attribution, estimated API-equivalent cost, turn latency/speed, and context breakdown.

### Structured `/compact` Templates & Deterministic Handoff (`LUNA-005`)

- **Structured `/compact` templates (opt-in, off by default):** Optionally append a structured compaction prompt without altering default upstream `/compact` behavior when disabled.
- **Deterministic handoff:** Generates a structured summary from local thread state and pre-fills a new thread draft so you can continue cleanly without background LLM summarization calls.

### Multi-Account Management, Subscription Tiers & Quota Breakdown (`LUNA-006`, `LUNA-009`)

- **Isolated account setup helper:** Guides manual creation of separate provider instances and config homes (never extracts OAuth tokens or rotates accounts automatically).
- **Per-account quota cards & comparisons:** Displays per-account quota windows, upstream subscription tier badges, and sibling-account remaining-quota comparisons in the model picker and thread details on Web, Desktop, and Mobile.
- **Kimi Code account & quota reader:** Reads `{KIMI_CODE_HOME:-~/.kimi-code}/credentials/kimi-code.json` (`/me` and `/usages`) using POSIX `oauth/<name>.lock` coordination (read-only on Windows), a 5-minute in-memory TTL cache, and `turn.agent_busy` single-turn steering/retry protection.

### OpenViking Cloud Memory — Delegated to Agent Plugins (`LUNA-008`, retired)

- Memory recall and capture come from each agent CLI's own OpenViking plugin, configured once in `~/.openviking/ovcli.conf`.
- LunaCode no longer ships an in-app memory client: running a second client against the same server meant a different search endpoint, a threshold that never filtered, and duplicate injection on every turn.

### LAN `.local` mDNS Discovery & Custom Domain Pairing (`LUNA-010`)

- Enabling **Network access** on macOS Desktop automatically reads the machine's `LocalHostName` and advertises `http://<host>.local:<port>/`.
- Under **Settings → Sharing & access**, switch pairing URLs and QR codes between LAN IP, `.local` hostname, and any custom LAN domain without restarting the server.

### Terminal Output Noise Reduction (`rtk`) (`LUNA-007`)

- Opt-in helper in Desktop Settings that checks for local [`rtk`](https://github.com/rtk-ai/rtk) and native Claude Code hooks and helps initialize them manually without silently mutating command output inside T3 Code.

---

## 4. Official Subscription Compliance & Antigravity Hardening (`LUNA-011`, `LUNA-013`)

- **Official CLI/ACP only:** Providers execute through their official CLIs or ACP adapters with zero MITM proxying, zero Keyring/token extraction, zero hardcoded OAuth secrets, and zero client/UA spoofing.
- **Antigravity quota handling:** Quota checks run only when you click **Refresh**, invoking `agy --print /usage --output-format json` with a 5-minute cooldown and per-instance offline cache (`antigravityQuotaCache.ts`). Personal Google subscriptions (`oauth-personal`) skip hidden background `TextGeneration` turns and system prompt appends.
- **Antigravity media & session recovery:**
  - Validates image and audio payloads before sending (`AntigravityAcpSupport.ts`), rejecting 0-byte files, corrupted headers, and Apple's non-standard `CgBI` PNGs (such as icons extracted from compiled iOS `.app` bundles) so they cannot poison the native Antigravity session.
  - Excludes trailing `SYSTEM_MESSAGE` (`step_type=101`) entries when checking Antigravity's native SQLite trajectory (`AntigravityTurnOutcome.ts`) and treats `INVALID_MEDIA_INPUT` as `broken` so the next turn automatically starts a fresh session with thread context.

---

## 5. Building Locally

```bash
# Install dependencies (from the lunacode branch)
vp i

# Start server + web dev environment
vp run dev

# Build locally signed macOS arm64 DMG
bash .claude/skills/lunacode-mac-dmg/scripts/build-signed-dmg.sh
```

For mobile builds (iOS & Android), see [`apps/mobile/README.md`](../apps/mobile/README.md) and [`docs/operations/development.md`](./operations/development.md).
