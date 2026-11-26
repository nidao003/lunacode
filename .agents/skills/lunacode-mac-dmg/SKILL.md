---
name: lunacode-mac-dmg
description: Build, sign locally, and verify the LunaCode macOS arm64 DMG installer (`release/LunaCode-*-arm64.dmg`). Use when the user asks to package, rebuild, sign, or verify the LunaCode macOS desktop app / DMG using local Xcode Apple Development credentials, or to troubleshoot local DMG signing and resource-monitor reuse.
---

# LunaCode macOS Signed DMG

Build and verify `release/LunaCode-<version>-arm64.dmg` cleanly on the `lunacode` fork using local Xcode `Apple Development` signing.

## 1. When to use & red lines

- **Use for**: Rebuilding `LunaCode-<version>-arm64.dmg` after frontend/desktop edits, auto-discovering local keychain `Apple Development` signing, and verifying the resulting DMG (`codesign`, `Info.plist`, update-feed isolation).
- **Branch guard**: Build on `lunacode` (or a fork feature branch), **never** on `main` (read-only upstream mirror per [AGENTS.fork.md](../../../AGENTS.fork.md)).
- **Scope**: macOS arm64 desktop DMG only. Never build iOS/mobile here, never auto-overwrite `/Applications/`, and never launch dev/packaged apps against live `~/.t3/userdata` during automated verification.
- **Personal Team certificate boundary**: A free Personal Team `Apple Development` certificate gives a stable local signature so macOS TCC/keychain permissions persist across rebuilds instead of breaking on ad-hoc hashes. It does **not** include paid Apple Developer Notarization (`Developer ID Application`) or Passkeys Provisioning Profiles (`--signed` remains reserved for official CI/paid signing).

## 2. One-command build & common flags

Run the bundled helper script from repo root (`.claude/skills/lunacode-mac-dmg` resolves to the same directory as `.agents/skills/lunacode-mac-dmg`):

```bash
# Default: preflight + auto-detect Apple Development cert + build DMG + read-only verify
bash .claude/skills/lunacode-mac-dmg/scripts/build-signed-dmg.sh
```

Useful flags:

| Flag                          | Purpose                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `--dry-run`                   | Run all preflight checks and print the resolved `vp run dist:desktop:dmg:arm64` command without building |
| `--verify-only [dmg-path]`    | Mount an existing DMG read-only and verify `codesign`, `Info.plist`, and absence of `app-update.yml`     |
| `--identity "<name-or-hash>"` | Override keychain auto-discovery with an explicit codesigning identity                                   |
| `--unsigned`                  | Explicitly skip local signing (`unset LUNACODE_LOCAL_MAC_SIGN_IDENTITY`)                                 |
| `--skip-verify`               | Build without mounting and verifying afterwards                                                          |
| `--allow-main`                | Override the safety refusal if intentionally testing from `main`                                         |

## 3. Certificate recovery (if keychain has 0 valid identities or cert expired)

1. Confirm Xcode already has a signed-in team:
   ```bash
   defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier
   ```
   (Look for e.g. `teamID = <YOUR_TEAM_ID>`, `isFreeProvisioningTeam = 1`.)
2. Bootstrap a temporary macOS C tool in `/tmp/lunacode-cert-bootstrap` so Xcode requests/installs the `Apple Development` certificate into `login.keychain-db`:
   ```bash
   rm -rf /tmp/lunacode-cert-bootstrap && mkdir -p /tmp/lunacode-cert-bootstrap/CertBootstrap.xcodeproj
   cat <<'EOF' > /tmp/lunacode-cert-bootstrap/main.c
   int main(void) { return 0; }
   EOF
   cat <<'EOF' > /tmp/lunacode-cert-bootstrap/CertBootstrap.xcodeproj/project.pbxproj
   // !$*UTF8*$!
   {
     archiveVersion = 1;
     classes = {};
     objectVersion = 56;
     objects = {
       111111111111111111110001 = {isa = PBXBuildFile; fileRef = 111111111111111111110002; };
       111111111111111111110002 = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.c; path = main.c; sourceTree = "<group>"; };
       111111111111111111110003 = {isa = PBXFileReference; explicitFileType = "compiled.mach-o.executable"; includeInIndex = 0; path = CertBootstrap; sourceTree = BUILT_PRODUCTS_DIR; };
       111111111111111111110004 = {isa = PBXGroup; children = (111111111111111111110002, 111111111111111111110005); sourceTree = "<group>"; };
       111111111111111111110005 = {isa = PBXGroup; children = (111111111111111111110003); name = Products; sourceTree = "<group>"; };
       111111111111111111110006 = {isa = PBXNativeTarget; buildConfigurationList = 111111111111111111110007; buildPhases = (111111111111111111110008); buildRules = (); dependencies = (); name = CertBootstrap; productName = CertBootstrap; productReference = 111111111111111111110003; productType = "com.apple.product-type.tool"; };
       111111111111111111110008 = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (111111111111111111110001); runOnlyForDeploymentPostprocessing = 0; };
       111111111111111111110009 = {isa = PBXProject; attributes = {BuildIndependentTargetsInParallel = 1; LastUpgradeCheck = 1500; TargetAttributes = {111111111111111111110006 = {CreatedOnToolsVersion = 15.0; DevelopmentTeam = <YOUR_TEAM_ID>; ProvisioningStyle = Automatic; }; }; }; buildConfigurationList = 111111111111111111110010; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; mainGroup = 111111111111111111110004; productRefGroup = 111111111111111111110005; targets = (111111111111111111110006); };
       111111111111111111110011 = {isa = XCBuildConfiguration; buildSettings = {MACOSX_DEPLOYMENT_TARGET = 13.0; SDKROOT = macosx; }; name = Debug; };
       111111111111111111110012 = {isa = XCBuildConfiguration; buildSettings = {CODE_SIGN_IDENTITY = "Apple Development"; CODE_SIGN_STYLE = Automatic; DEVELOPMENT_TEAM = <YOUR_TEAM_ID>; PRODUCT_BUNDLE_IDENTIFIER = com.nidao003.lunacode.certbootstrap; PRODUCT_NAME = "$(TARGET_NAME)"; }; name = Debug; };
       111111111111111111110010 = {isa = XCConfigurationList; buildConfigurations = (111111111111111111110011); defaultConfigurationName = Debug; };
       111111111111111111110007 = {isa = XCConfigurationList; buildConfigurations = (111111111111111111110012); defaultConfigurationName = Debug; };
     };
     rootObject = 111111111111111111110009;
   }
   EOF
   xcodebuild -project /tmp/lunacode-cert-bootstrap/CertBootstrap.xcodeproj -target CertBootstrap -configuration Debug -destination 'platform=macOS,arch=arm64' -allowProvisioningUpdates build
   rm -rf /tmp/lunacode-cert-bootstrap
   security find-identity -v -p codesigning
   ```
   (Replace `<YOUR_TEAM_ID>` with your Xcode `teamID` from step 1. If Apple session/2FA expired, open Xcode Settings -> Accounts to re-authenticate instead of scripting logins.)

## 4. Known pitfalls

- **`TMPDIR=/tmp` is mandatory**: If `/Users/<user>/node_modules` exists above the workspace, `verifyPackagedBundleIsSelfContained` fails unless `TMPDIR=/tmp` isolates staging away from `$HOME`. The helper script sets `TMPDIR=/tmp` automatically.
- **No Rust / Cargo on machine**: Pass `T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=1` when `native/resource-monitor/target/aarch64-apple-darwin/release/t3-resource-monitor` is already staged. If that binary is missing and Cargo isn't installed, copy it from a matching upstream T3 Code bundle:
  `/Applications/T3 Code (Beta).app/Contents/Resources/resource-monitor/t3-resource-monitor`.
- **Personal Team timestamp rejection**: `scripts/build-desktop-artifact.ts` enables local macOS signing via `LUNACODE_LOCAL_MAC_SIGN_IDENTITY` while intentionally setting `hardenedRuntime: false` and `timestamp: "none"` because Apple TSA rejects local Personal Team `Apple Development` signing with `A timestamp was expected but was not found`.

## 5. Verification checklist & output contract

Before handing a built `.dmg` back to the user, confirm `build-signed-dmg.sh` reported:

- [ ] `Info.plist`: `CFBundleIdentifier=com.nidao003.lunacode`, `CFBundleName=LunaCode`, URL schemes contain `lunacode`
- [ ] Update isolation: `Contents/Resources/app-update.yml` is absent
- [ ] `codesign -dv --verbose=4`: non-adhoc `Authority=Apple Development: ...` (unless `--unsigned` was explicitly requested) and `TeamIdentifier` present
- [ ] `codesign --verify --deep --strict`: passed
- [ ] Report exact `.dmg` file path, size, signing authority, and remind the user to manually drag `LunaCode.app` into `/Applications/`
