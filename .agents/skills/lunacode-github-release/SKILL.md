---
name: lunacode-github-release
description: Trigger, check, and manage LunaCode's multi-platform GitHub Actions packaging and release pipeline (`.github/workflows/lunacode-release.yml`) for macOS (arm64/x64 DMG/ZIP), Linux (x64 AppImage/DEB), Windows (x64 NSIS EXE), Android (arm64-v8a Release APK), and iOS (unsigned sideload-ready IPA). Use whenever the user says "github打包", "GitHub 打包", "GitHub 发布", "触发打包", "自动打包", "发版", or asks to dispatch/check LunaCode's cloud release builds. For local signed macOS DMG builds, use `lunacode-mac-dmg` instead.
---

# LunaCode GitHub Release

Trigger and inspect LunaCode's multi-platform cloud build & release workflow ([lunacode-release.yml](../../../.github/workflows/lunacode-release.yml)) on `nidao003/lunacode`.

## 1. When to use & red lines

- **Use for**: Dispatching or checking remote GitHub Actions builds (`ubuntu-24.04` + `macos-26`) for Desktop (macOS DMG/ZIP, Linux AppImage/DEB, Windows NSIS EXE), Android Release APK, and iOS unsigned IPA.
- **For local signed macOS DMG**: Use [lunacode-mac-dmg](../lunacode-mac-dmg/SKILL.md) instead.
- **Branch guard**: Always dispatch against `lunacode` (or a fork feature branch), **never** `main` (`main` is a read-only upstream mirror per [AGENTS.fork.md](../../../AGENTS.fork.md)).
- **Remote-first reminder**: GitHub Actions builds commits already pushed to `origin/lunacode`, NOT uncommitted local edits or unpushed commits. If `--inspect` shows unpushed commits or modified tracked files, alert the user before dispatching (and **never** auto-commit or push without explicit user confirmation).
- **Keep upstream workflows disabled**: Never re-enable the 27 disabled upstream workflows (only `Upstream Sync` and `LunaCode Release` stay active).

## 2. Standard Workflow (Preflight -> Ask if uncertain -> Dispatch -> Confirm)

### Step 1 — Preflight (`--inspect`)

**ALWAYS** run the helper script's preflight first (`.claude/skills/lunacode-github-release` resolves identically via `.agents/skills/lunacode-github-release`):

```bash
bash .claude/skills/lunacode-github-release/scripts/dispatch-release.sh --inspect
```

This reports:

- Current branch, `origin/lunacode` ahead/behind counts, and dirty tracked file count
- Desktop version in `apps/desktop/package.json` and mobile version in `apps/mobile/app.config.ts`
- Latest 5 `lunacode-v*` local/remote tags
- Latest 5 GitHub Releases
- Latest 3 `lunacode-release.yml` workflow runs

### Step 2 — Version & Release-Mode Decision Gate (MUST consult user when uncertain)

**Pause and ask the user concisely before triggering** if **ANY** of the following hold:

1. **Uncertain version**: User did not specify a version string AND any of:
   - A `lunacode-v<version>` tag or GitHub Release already exists for the current `apps/desktop/package.json` version;
   - `publish_release=true` (public GitHub Release);
   - It is unclear whether to build with the current manifest version or bump/suffix it (e.g. `0.1.11` vs `0.1.11-luna.1`).
2. **Uncertain publish mode**: User did not specify whether to only upload downloadable Actions Artifacts (`publish_release=false`) or publish a public GitHub Release (`publish_release=true`).
3. **Unpushed or uncommitted local changes**: `--inspect` shows `ahead > 0` or `modified tracked files > 0` that the user likely expects included in the cloud build.

When consulting the user, show the real inspected values (desktop version, mobile version, latest `lunacode-v*` tag/release, local git sync state) and present crisp options:

- **Version**: e.g. keep current manifest version (`0.1.11`), add suffix (`0.1.11-luna.1`), or specify custom version
- **Mode**: Artifacts only (`publish_release=false`, safe test build) vs Publish GitHub Release (`publish_release=true`) / Pre-release (`--prerelease`)
- **Platforms**: Default all (`mac-arm64`, `linux-x64`, `win-x64`, `android`, `ios`) or subset (plus optional `mac-x64`)

**Direct dispatch without extra round-trips** is allowed ONLY when:

- The user already gave the exact version (or explicitly confirmed keeping the current version / "按默认触发"),
- Publish mode and platforms are clear (or user said "按默认触发"), and
- There are no unexpected unpushed commits or dirty tracked edits waiting to be included.

### Step 3 — Dispatch

Run `dispatch-release.sh` with the confirmed parameters:

```bash
bash .claude/skills/lunacode-github-release/scripts/dispatch-release.sh \
  --version 0.1.11 \
  --no-publish \
  --platforms default
```

### Step 4 — Confirm Start & Report

Immediately check the dispatched run with `--status` (never poll in a loop or block waiting 30+ minutes for all platforms to finish):

```bash
bash .claude/skills/lunacode-github-release/scripts/dispatch-release.sh --status [run-id]
```

Report the live **Run URL**, branch, resolved version, publish mode, enabled targets, and initial job states.

## 3. Quick Command Reference

| Action                                   | Command                                                                                                                                          |
| :--------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------- |
| Preflight inspect                        | `bash .claude/skills/lunacode-github-release/scripts/dispatch-release.sh --inspect`                                                              |
| Dry run preview                          | `bash .claude/skills/lunacode-github-release/scripts/dispatch-release.sh --dry-run --version 0.1.11 --platforms default`                         |
| Artifacts-only build (default platforms) | `bash .claude/skills/lunacode-github-release/scripts/dispatch-release.sh --no-publish --platforms default`                                       |
| Publish public GitHub Release            | `bash .claude/skills/lunacode-github-release/scripts/dispatch-release.sh --version 0.1.11 --publish --platforms default`                         |
| Publish pre-release with `mac-x64`       | `bash .claude/skills/lunacode-github-release/scripts/dispatch-release.sh --version 0.1.11-luna.1 --publish --prerelease --platforms all+mac-x64` |
| Mobile-only build (Android + iOS)        | `bash .claude/skills/lunacode-github-release/scripts/dispatch-release.sh --no-publish --platforms mobile`                                        |
| Check latest (or specific) run status    | `bash .claude/skills/lunacode-github-release/scripts/dispatch-release.sh --status [run-id]`                                                      |

## 4. Alternative Tag-Push Release Flow

Pushing a `lunacode-v*` tag automatically triggers `lunacode-release.yml` with `publish_release=true` and default platforms (`mac-arm64`, `linux-x64`, `win-x64`, `android`, `ios`):

```bash
git tag lunacode-v<version> lunacode
git push origin lunacode-v<version>
```

- Always use the `lunacode-v*` prefix so tags never collide with upstream `v*` release/nightly tags.
- Creating/pushing tags is a Git mutation: always confirm explicitly with the user first.

## 5. Artifacts & Signing Notes

| Platform    | Produced Files                                       | Signing / Install Notes                                                                                                                                                                                                                                       |
| :---------- | :--------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **macOS**   | `LunaCode-<ver>-arm64.dmg` / `.zip` (optional `x64`) | Unsigned unless `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_TEAM_ID` (var), `MACOS_PROVISIONING_PROFILE` are configured. First launch on unsigned builds requires `xattr -cr /Applications/LunaCode.app`. |
| **Linux**   | `LunaCode-<ver>-x86_64.AppImage`, `.deb`             | `chmod +x LunaCode-*.AppImage` or `sudo apt install ./LunaCode-*.deb`.                                                                                                                                                                                        |
| **Windows** | `LunaCode-<ver>-x64.exe` (NSIS)                      | Cross-built on `ubuntu-24.04` via `cargo-xwin`; SmartScreen warning expected while unsigned.                                                                                                                                                                  |
| **Android** | `LunaCode-mobile-<mobileVer>-arm64-v8a-release.apk`  | Uses default debug keystore unless `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` Secrets are set. Note mobile uses `apps/mobile/app.config.ts` version (`2.3.0`), independent of `--version`.           |
| **iOS**     | `LunaCode-mobile-<mobileVer>-ios-unsigned.ipa`       | Built on `macos-26` (Xcode 26 SDK) with `T3CODE_IOS_PERSONAL_TEAM=1` (`com.nidao003.lunacode.mobile`). Sideload via AltStore, SideStore, Sideloadly (personal Apple ID re-sign), or TrollStore.                                                               |
