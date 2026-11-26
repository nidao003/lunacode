<p align="center">
  <img src="./assets/lunacode/lunacode-web-icon-192x192.png" width="88" height="88" alt="LunaCode Chang'e icon" />
</p>

<h1 align="center">LunaCode</h1>

<p align="center">A privacy-first, multi-surface control plane for coding agents — forked from <a href="https://github.com/pingdotgg/t3code">T3 Code</a>.</p>

<p align="center">
  <a href="#whats-new-in-lunacode-vs-upstream-t3-code">What's New in LunaCode</a> ·
  <a href="#design-principles--guardrails">Guardrails</a> ·
  <a href="#build--install-from-source">Build &amp; Install</a> ·
  <a href="./docs/lunacode.md">LunaCode Guide</a> ·
  <a href="./docs/README.md">All Docs</a> ·
  <a href="https://github.com/pingdotgg/t3code">Upstream T3 Code</a>
</p>

> **Fork Notice:** **LunaCode** ([`nidao003/lunacode`](https://github.com/nidao003/lunacode)) is an independent open-source fork of [**T3 Code**](https://github.com/pingdotgg/t3code) by T3 Tools Inc. (MIT License). `main` mirrors `upstream/main` automatically; all LunaCode customizations live on the [`lunacode`](https://github.com/nidao003/lunacode/tree/lunacode) branch while preserving bidirectional compatibility with `~/.t3/userdata`.

LunaCode runs the coding agents already installed on your machine and gives them one fast, remote-ready interface across **Desktop**, **Web**, and **Mobile (iOS & Android)**. It works with Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, Kimi Code, and any [ACP](./docs/user/providers-acp.md) agent—using your own subscriptions and API credentials.

---

## Inherited from Upstream T3 Code

LunaCode builds directly on upstream T3 Code's core architecture and feature set:

- **Bring your own subscriptions.** Drives the provider CLIs and SDKs you are already signed in to; never resells tokens.
- **Every agent in one control plane.** Switch models mid-thread or coordinate work across Claude, Codex, Antigravity, Cursor, OpenCode, Grok, Kiro, Pi, Muse Code, fx, and ACP registry agents.
- **Desktop, web, and phone.** One Node/Effect WebSocket server powers Electron desktop, browser web UI, and React Native iOS/Android clients.
- **Remote ready.** Connect over LAN, Tailscale HTTPS, SSH, or Cloudflare tunnels, with per-thread Git worktrees, diff review, PR workflows, and built-in browser/device previews.

---

## What's New in LunaCode (vs. Upstream T3 Code)

All custom capabilities are tracked in the [Customizations Ledger](./AGENTS.fork.md#5-二开定制清单customizations-ledger) (`LUNA-001`–`LUNA-015`) and documented in detail in the [LunaCode Guide](./docs/lunacode.md).

### 1. Independent Identity, Chang'e Artwork & Safe Coexistence (`LUNA-001`, `LUNA-002`)

- **Dedicated branding & bundle IDs:** Ships as **LunaCode** (`com.nidao003.lunacode` on Desktop, `com.nidao003.lunacode.mobile` on iOS/Android) with custom moon/Chang'e icon assets across macOS, Windows, Linux, Web, iOS, and Android (`assets/lunacode/`).
- **Side-by-side coexistence with official T3 Code:** Uses an isolated Electron `userData` directory (`lunacode-v2`), disables the upstream auto-updater (`app-update.yml` omitted), and supports local macOS `Apple Development` signing via `.claude/skills/lunacode-mac-dmg/scripts/build-signed-dmg.sh`.
- **Shared data & dual-launch guard:** Continues sharing `~/.t3/userdata` safely with official `T3 Code (Beta).app`, detects when the official app holds the home lock, and offers a one-click guided handoff to quit it cleanly before taking over.

### 2. Privacy by Default: Telemetry & Crash Reporting Off (`LUNA-012`)

- **Server analytics off by default:** Upstream PostHog product analytics (`ingest.t3.codes`) defaults to disabled (`T3CODE_TELEMETRY_ENABLED=false`) and only runs if you explicitly opt in with `T3CODE_TELEMETRY_ENABLED=true`.
- **Mobile crash reporting & tracing disabled:** `expo-observe` relay crash reporting is permanently disabled on mobile, and upstream Axiom OTLP tracing is disabled unless you explicitly configure your own `EXPO_PUBLIC_OTLP_TRACES_TOKEN`.

### 3. Local Context Telemetry, Cache Inspector & Turn Speed — Web & Mobile (`LUNA-003`, `LUNA-004`)

- **Zero-extra-token footer bar:** Real-time context window usage bar, warning threshold marker, prompt cache hit rate, cache TTL countdown, and per-turn output speed badge (`tok/s`) rendered purely from existing local usage data across Desktop, Web, iOS, and Android.
- **Context & Cache Inspector:** Interactive modal/dialog breaking down capacity, threshold settings, cache attribution, API-equivalent cost estimate, per-turn latency/speed, and context composition, backed by shared logic in `packages/client-runtime/src/lunacode/`.

### 4. Compliant Compaction & Deterministic Handoff — Web & Mobile (`LUNA-005`)

- **Optional structured `/compact` templates:** Off by default to avoid altering upstream compaction behavior unless explicitly enabled by the user.
- **Deterministic structured handoff:** One-click "compact & continue in a new thread" workflow that generates a deterministic summary draft into a fresh thread without extra LLM calls or traffic interception.

### 5. Multi-Account Setup & Per-Account Quota Breakdown — Web & Mobile (`LUNA-006`, `LUNA-009`)

- **Guided isolated accounts (manual switch only):** Setup helper for isolated provider configuration directories (Claude, Antigravity, etc.) with **no automatic account rotation**.
- **Per-account quota cards & tier badges:** Splits pooled limits into per-account cards with upstream subscription tier badges, remaining quota pills, and sibling-account comparisons inside the model picker and thread sidebar on both Web/Desktop and Mobile.
- **Kimi Code quota integration:** Compliant credential/quota reader (`~/.kimi-code/credentials/kimi-code.json`, `/me`, `/usages`) with POSIX file-lock coordination, Windows read-only protection, a 5-minute in-memory TTL cache, and `turn.agent_busy` single-turn steering/retry protection.

### 6. OpenViking Cloud Memory — Delegated to Agent Plugins (`LUNA-008`, retired)

- Memory recall and capture are provided by each agent CLI's own OpenViking plugin (Claude Code, Codex, OpenCode, Pi, Cursor), configured once in `~/.openviking/ovcli.conf`.
- LunaCode ships no separate memory client, so the same server is not queried twice with different endpoints, thresholds, and injection paths.

### 7. LAN `.local` mDNS Discovery & Custom Domain Pairing (`LUNA-010`)

- **Automatic `.local` hostname broadcast:** When **Network access** is enabled on macOS Desktop, LunaCode automatically discovers and advertises the machine's mDNS address (`http://<hostname>.local:<port>/`).
- **Instant link & QR switching:** Switch default pairing URLs and QR codes between LAN IP, `.local` hostname, and any custom LAN domain without restarting the server.

### 8. Terminal Output Noise Reduction (`rtk` Integration) (`LUNA-007`)

- **Opt-in desktop helper:** Detects local [`rtk`](https://github.com/rtk-ai/rtk) installations and Claude Code hooks in **Settings**, guiding manual setup without silently rewriting tool output or truncating errors.

### 9. Official Subscription Compliance & Antigravity Hardening (`LUNA-011`, `LUNA-013`)

- **Strict ToS compliance:** Runs every provider solely through its official CLI/ACP runtime—no OAuth credential/Keyring extraction, no hardcoded Google client secrets, no forged IDE client identities or User-Agents, no private undocumented quota endpoints (`v1internal`, `/api/oauth/usage`), and no hidden background `TextGeneration` helper turns on personal subscriptions.
- **Manual-only Antigravity quota refresh & offline cache:** Refreshes Antigravity limits only on explicit user click via `agy --print /usage --output-format json` with a 5-minute cooldown and persisted per-instance offline cache.
- **Antigravity media poisoning protection & session recovery:** Pre-validates image/audio attachments before prompting (rejecting 0-byte files, corrupted headers, and non-standard Apple `CgBI` PNGs extracted from iOS `.app` bundles), skips trailing `SYSTEM_MESSAGE` (`step_type=101`) steps in session logs so error steps aren't masked during `/compact`, and marks `INVALID_MEDIA_INPUT` errors as `broken` so the next turn automatically recovers into a fresh Antigravity session.

---

## Design Principles & Guardrails

1. **Official Subscription Compliance:** No traffic MITM, no private credential scraping, no client spoofing, no background keep-alive probes, and no automatic multi-account rotation pools.
2. **Zero Hidden Token Spend:** Context telemetry, cache stats, cost estimation, and handoff assembly are 100% local deterministic computations; memory recall and compaction are user-triggered only.
3. **Zero Reasoning / Context Degradation:** System Prompts, reasoning effort levels, tool definitions, and error stack traces are never silently altered or truncated.
4. **Upstream Data Compatibility:** Preserves `~/.t3/userdata/statev2.sqlite` schemas so you can switch freely between official T3 Code and LunaCode at any time.

---

## Build & Install from Source

> **Branch model:** Always work from `lunacode` (never develop or commit on `main`, which tracks `upstream/main`). See [`AGENTS.fork.md`](./AGENTS.fork.md) for the fork workflow and upstream merge SOP.

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

This outputs `release/LunaCode-<version>-arm64.dmg` signed with your local Xcode `Apple Development` identity (or pass `--unsigned` for an unsigned build).

### Build Mobile (iOS & Android)

See [`apps/mobile/README.md`](./apps/mobile/README.md) and the [development runbook](./docs/operations/00_development.md) for Expo native builds, device installation, and local testing.

---

## Documentation

- [LunaCode Features & Fork Guide](./docs/lunacode.md)
- [Fork Workflow, Compliance Guardrails & Customizations Ledger (`AGENTS.fork.md`)](./AGENTS.fork.md)
- [Install and First Run](./docs/user/install.md)
- [Remote Access & LAN Pairing](./docs/user/remote-access.md)
- [Usage and Limits](./docs/user/usage.md)
- [Product Usage Data & Privacy](./docs/user/telemetry.md)
- [Updating](./docs/user/updating.md)
- [FAQ](./docs/user/faq.md)
- [All Docs Index](./docs/README.md)

---

## Upstream Attribution & License

LunaCode is forked from [**T3 Code (`pingdotgg/t3code`)**](https://github.com/pingdotgg/t3code), created by Theo Browne, Julius Marminge, and T3 Tools Inc.

Licensed under the [MIT License](./LICENSE).

## Trademarks and forks

The MIT license applies **only to the source code**. It does not grant any rights to T3 Tools, Inc.'s trademarks, branding, or trade dress, including the **T3 Code** name, wordmark, logos, and application icons.

LunaCode is an independent, unofficial fork. Do not use the T3 Code name, wordmark, logos, or application icons in a way that suggests official status or affiliation. See [TRADEMARK.md](./TRADEMARK.md) for the full trademark and branding policy.
