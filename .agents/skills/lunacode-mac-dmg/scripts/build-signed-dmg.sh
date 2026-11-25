#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: build-signed-dmg.sh [options]

Build and verify LunaCode's locally-signed macOS arm64 DMG installer.

Options:
  --identity <name-or-hash>   Use explicit codesigning identity (overrides keychain lookup)
  --unsigned                  Skip local signing (explicit unsigned build)
  --dry-run                   Run preflight checks and print resolved build command only
  --verify-only [dmg-path]    Skip build and run read-only DMG verification
  --skip-verify               Skip post-build DMG verification
  --allow-main                Allow running when checked out on main branch
  -h, --help                  Show this help message
EOF
}

SIGN_IDENTITY=""
IDENTITY_EXPLICIT=0
UNSIGNED=0
DRY_RUN=0
VERIFY_ONLY=0
VERIFY_DMG_PATH=""
SKIP_VERIFY=0
ALLOW_MAIN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --identity)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --identity requires an argument." >&2
        exit 2
      fi
      SIGN_IDENTITY="$2"
      IDENTITY_EXPLICIT=1
      shift 2
      ;;
    --identity=*)
      SIGN_IDENTITY="${1#*=}"
      IDENTITY_EXPLICIT=1
      shift 1
      ;;
    --unsigned)
      UNSIGNED=1
      shift 1
      ;;
    --dry-run)
      DRY_RUN=1
      shift 1
      ;;
    --verify-only)
      VERIFY_ONLY=1
      if [[ $# -ge 2 && "$2" != -* ]]; then
        VERIFY_DMG_PATH="$2"
        shift 2
      else
        shift 1
      fi
      ;;
    --skip-verify)
      SKIP_VERIFY=1
      shift 1
      ;;
    --allow-main)
      ALLOW_MAIN=1
      shift 1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$UNSIGNED" -eq 1 && "$IDENTITY_EXPLICIT" -eq 1 ]]; then
  echo "ERROR: --unsigned and --identity cannot be used together." >&2
  exit 2
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
if [[ "$BRANCH" == "main" && "$ALLOW_MAIN" -ne 1 ]]; then
  echo "ERROR: Refusing to run on 'main' branch (read-only upstream mirror per AGENTS.fork.md)." >&2
  echo "Switch to 'lunacode' branch or pass --allow-main to override." >&2
  exit 1
fi

if ! command -v vp >/dev/null 2>&1 && [[ -f "$HOME/.config/vite-plus/env" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.config/vite-plus/env"
fi

if [[ "$VERIFY_ONLY" -eq 0 ]] && ! command -v vp >/dev/null 2>&1; then
  echo "ERROR: 'vp' CLI not found in PATH and '$HOME/.config/vite-plus/env' was not available." >&2
  exit 1
fi

RESOURCE_MONITOR_BIN="$REPO_ROOT/native/resource-monitor/target/aarch64-apple-darwin/release/t3-resource-monitor"
REUSE_RESOURCE_MONITOR=0
if [[ "$VERIFY_ONLY" -eq 0 ]]; then
  if [[ -x "$RESOURCE_MONITOR_BIN" ]]; then
    REUSE_RESOURCE_MONITOR=1
  elif ! command -v cargo >/dev/null 2>&1; then
    echo "ERROR: Neither prebuilt t3-resource-monitor nor Rust 'cargo' was found." >&2
    echo "Missing binary: $RESOURCE_MONITOR_BIN" >&2
    echo "Recovery options:" >&2
    echo "  1) Copy from installed official T3 Code app (if version matches):" >&2
    echo "     mkdir -p \"$(dirname "$RESOURCE_MONITOR_BIN")\"" >&2
    echo "     cp \"/Applications/T3 Code (Beta).app/Contents/Resources/resource-monitor/t3-resource-monitor\" \"$RESOURCE_MONITOR_BIN\"" >&2
    echo "     chmod +x \"$RESOURCE_MONITOR_BIN\"" >&2
    echo "  2) Or install Rust/Cargo so the build compiles t3-resource-monitor." >&2
    exit 1
  fi
fi

discover_signing_identity() {
  local identities
  identities="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/^[[:space:]]*[0-9]*) [0-9A-Fa-f]* "\([^"]*\)"$/\1/p' || true)"
  if [[ -z "$identities" ]]; then
    return 1
  fi

  local match
  match="$(printf '%s\n' "$identities" | grep -m1 '^Apple Development: ' || true)"
  if [[ -n "$match" ]]; then
    printf '%s\n' "$match"
    return 0
  fi

  match="$(printf '%s\n' "$identities" | grep -m1 '^Developer ID Application: ' || true)"
  if [[ -n "$match" ]]; then
    printf '%s\n' "$match"
    return 0
  fi

  return 1
}

if [[ "$VERIFY_ONLY" -eq 0 && "$UNSIGNED" -eq 0 ]]; then
  if [[ "$IDENTITY_EXPLICIT" -eq 0 ]]; then
    if [[ -n "${LUNACODE_LOCAL_MAC_SIGN_IDENTITY:-}" ]]; then
      SIGN_IDENTITY="$(printf '%s' "$LUNACODE_LOCAL_MAC_SIGN_IDENTITY" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    else
      SIGN_IDENTITY="$(discover_signing_identity || true)"
    fi
  else
    SIGN_IDENTITY="$(printf '%s' "$SIGN_IDENTITY" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  fi

  if [[ -z "$SIGN_IDENTITY" ]]; then
    echo "ERROR: No valid 'Apple Development' (or 'Developer ID Application') codesigning identity found in login keychain." >&2
    echo "Options:" >&2
    echo "  - Bootstrap Personal Team certificate via Xcode CLI (see .claude/skills/lunacode-mac-dmg/SKILL.md)," >&2
    echo "  - Pass '--identity \"<name-or-hash>\"' explicitly, or" >&2
    echo "  - Pass '--unsigned' to build an unsigned DMG." >&2
    exit 1
  fi
fi

resolve_app_version() {
  python3 -c 'import json; print(json.load(open("apps/desktop/package.json"))["version"])'
}

resolve_expected_dmg_path() {
  printf '%s\n' "$REPO_ROOT/release/LunaCode-$(resolve_app_version)-arm64.dmg"
}

# --verify-only may fall back to the newest DMG; a build must prove the artifact is the one it just made.
resolve_dmg_path() {
  if [[ -n "$VERIFY_DMG_PATH" ]]; then
    printf '%s\n' "$VERIFY_DMG_PATH"
    return 0
  fi

  local expected newest
  expected="$(resolve_expected_dmg_path)"
  if [[ -f "$expected" ]]; then
    printf '%s\n' "$expected"
    return 0
  fi

  newest="$(ls -t "$REPO_ROOT"/release/LunaCode-*-arm64.dmg 2>/dev/null | head -n1 || true)"
  if [[ -n "$newest" ]]; then
    printf '%s\n' "$newest"
    return 0
  fi

  return 1
}

# A failed build leaves the previous DMG in place, so its name alone proves nothing.
# Sets BUILT_DMG instead of printing: the guard reads BUILD_STARTED_AT, and `$(...)` would run in a
# subshell that never sees this script's variables.
resolve_built_dmg_path() {
  local expected
  expected="$(resolve_expected_dmg_path)"
  BUILT_DMG=""
  if [[ ! -f "$expected" ]]; then
    return 1
  fi
  # Whole seconds only: `-nt` sees filesystem sub-second stamps that differ within one second, which
  # made a fast rebuild look older than its own marker.
  if [[ -n "${BUILD_STARTED_AT_SECONDS:-}" ]]; then
    local artifact_seconds
    artifact_seconds="$(stat -f '%m' "$expected" 2>/dev/null || stat -c '%Y' "$expected")"
    if (( artifact_seconds < BUILD_STARTED_AT_SECONDS )); then
      return 1
    fi
  fi
  BUILT_DMG="$expected"
}

verify_dmg() {
  local dmg_path="$1"
  if [[ ! -f "$dmg_path" ]]; then
    echo "ERROR: DMG not found: $dmg_path" >&2
    exit 1
  fi

  local mount_dir mounted
  mount_dir="$(mktemp -d /tmp/lunacode-verify-dmg.XXXXXX)"
  mounted=0

  cleanup_mount() {
    if [[ "$mounted" -eq 1 ]]; then
      hdiutil detach "$mount_dir" -quiet >/dev/null 2>&1 || hdiutil detach "$mount_dir" -force -quiet >/dev/null 2>&1 || true
      mounted=0
    fi
    rmdir "$mount_dir" 2>/dev/null || true
  }
  trap cleanup_mount EXIT

  echo "[lunacode-dmg] Mounting read-only for verification: $dmg_path"
  hdiutil attach -nobrowse -readonly -mountpoint "$mount_dir" "$dmg_path" >/dev/null
  mounted=1

  local app_path="$mount_dir/LunaCode.app"
  if [[ ! -d "$app_path" ]]; then
    echo "ERROR: LunaCode.app not found inside DMG at $app_path" >&2
    exit 1
  fi

  echo "[lunacode-dmg] Verifying Info.plist & update-feed isolation..."
  local plist_summary
  plist_summary="$(
    plutil -convert json -o - "$app_path/Contents/Info.plist" | python3 -c '
import json, sys
p = json.load(sys.stdin)
bid = p.get("CFBundleIdentifier")
bname = p.get("CFBundleName")
dname = p.get("CFBundleDisplayName")
ver = p.get("CFBundleShortVersionString")
schemes = []
for t in p.get("CFBundleURLTypes") or []:
    schemes.extend(t.get("CFBundleURLSchemes") or [])
assert bid == "com.nidao003.lunacode", f"Unexpected CFBundleIdentifier: {bid!r}"
assert bname == "LunaCode", f"Unexpected CFBundleName: {bname!r}"
assert "lunacode" in schemes, f"Missing lunacode URL scheme in: {schemes!r}"
print(f"CFBundleIdentifier={bid} | CFBundleDisplayName={dname} | Version={ver} | URLSchemes={schemes}")
'
  )"
  echo "  $plist_summary"

  if [[ -e "$app_path/Contents/Resources/app-update.yml" ]]; then
    echo "ERROR: Unexpected app-update.yml present in $app_path/Contents/Resources/" >&2
    exit 1
  fi
  echo "  Update isolation OK (no app-update.yml)."

  local signing_summary
  if [[ "$UNSIGNED" -eq 1 ]]; then
    signing_summary="unsigned (--unsigned)"
    echo "  [unsigned] Skipped strict codesign check."
  else
    echo "[lunacode-dmg] Verifying codesign..."
    local codesign_info
    codesign_info="$(codesign -dv --verbose=4 "$app_path" 2>&1 || true)"
    if printf '%s\n' "$codesign_info" | grep -q 'Signature=adhoc'; then
      echo "ERROR: App is ad-hoc signed rather than signed with an Apple certificate." >&2
      printf '%s\n' "$codesign_info" >&2
      exit 1
    fi
    if ! printf '%s\n' "$codesign_info" | grep -q '^Authority='; then
      echo "ERROR: No signing Authority found on $app_path." >&2
      printf '%s\n' "$codesign_info" >&2
      exit 1
    fi
    codesign --verify --deep --strict "$app_path"
    signing_summary="$(printf '%s\n' "$codesign_info" | grep -E '^(Identifier|Authority|TeamIdentifier)=' | tr '\n' '; ' | sed 's/; $//')"
    echo "  codesign --verify --deep --strict: OK"
    echo "  $signing_summary"
  fi

  cleanup_mount
  trap - EXIT

  echo ""
  echo "[lunacode-dmg] Verification passed."
  ls -lh "$dmg_path"
  echo "Signing : $signing_summary"
  echo "Install : 打开 DMG 后手动将 LunaCode.app 拖入 /Applications/；不会自动修改 /Applications/ 或 ~/.t3/userdata。"
}

if [[ "$VERIFY_ONLY" -eq 1 ]]; then
  TARGET_DMG="$(resolve_dmg_path || true)"
  if [[ -z "$TARGET_DMG" ]]; then
    echo "ERROR: No arm64 DMG found under $REPO_ROOT/release/" >&2
    exit 1
  fi
  verify_dmg "$TARGET_DMG"
  exit 0
fi

BUILD_ENV=("TMPDIR=/tmp")
if [[ "$REUSE_RESOURCE_MONITOR" -eq 1 ]]; then
  BUILD_ENV+=("T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=1")
fi
if [[ "$UNSIGNED" -eq 0 ]]; then
  BUILD_ENV+=("LUNACODE_LOCAL_MAC_SIGN_IDENTITY=$SIGN_IDENTITY")
fi

echo "[lunacode-dmg] Preflight summary:"
echo "  Branch                  : $BRANCH"
echo "  TMPDIR                  : /tmp"
echo "  Reuse resource monitor  : $REUSE_RESOURCE_MONITOR"
if [[ "$UNSIGNED" -eq 1 ]]; then
  echo "  Signing                 : disabled (--unsigned)"
else
  echo "  Signing identity        : $SIGN_IDENTITY"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[lunacode-dmg] Dry-run command:"
  if [[ "$UNSIGNED" -eq 1 ]]; then
    printf '  env -u LUNACODE_LOCAL_MAC_SIGN_IDENTITY'
  else
    printf '  env'
  fi
  for item in "${BUILD_ENV[@]}"; do
    printf ' %q' "$item"
  done
  printf ' vp run dist:desktop:dmg:arm64\n'
  exit 0
fi

echo "[lunacode-dmg] Starting DMG build..."
# Whole-second floor of the moment the build starts. A DMG written in the same second or later is
# this run's; anything from an earlier second is the previous build's leftover.
BUILD_STARTED_AT_SECONDS="$(date +%s)"
if [[ "$UNSIGNED" -eq 1 ]]; then
  env -u LUNACODE_LOCAL_MAC_SIGN_IDENTITY "${BUILD_ENV[@]}" vp run dist:desktop:dmg:arm64
else
  env "${BUILD_ENV[@]}" vp run dist:desktop:dmg:arm64
fi

BUILT_DMG=""
if ! resolve_built_dmg_path; then
  echo "ERROR: Build finished but this run produced no DMG for version $(resolve_app_version)." >&2
  echo "       Expected a file newer than the build start: $(resolve_expected_dmg_path)" >&2
  echo "       An older DMG in release/ is left over from a previous build; it is not verified or reported." >&2
  exit 1
fi

if [[ "$SKIP_VERIFY" -eq 1 ]]; then
  echo "[lunacode-dmg] Build complete (--skip-verify set):"
  ls -lh "$BUILT_DMG"
  echo "Install : 打开 DMG 后手动将 LunaCode.app 拖入 /Applications/；不会自动修改 /Applications/ 或 ~/.t3/userdata。"
else
  verify_dmg "$BUILT_DMG"
fi
