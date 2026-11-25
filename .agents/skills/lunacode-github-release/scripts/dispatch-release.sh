#!/usr/bin/env bash
set -euo pipefail

REPO="${LUNACODE_GH_REPO:-nidao003/lunacode}"
WORKFLOW="lunacode-release.yml"
FALLBACK_PROXY="http://127.0.0.1:7890"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || (cd "$SCRIPT_DIR/../../../.." && pwd))"

MODE="dispatch"
STATUS_RUN_ID=""
REF="lunacode"
ALLOW_MAIN=0
VERSION=""
PUBLISH_RELEASE="false"
PRERELEASE="false"
PLATFORMS="default"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: dispatch-release.sh [options]

Modes:
  --inspect                  Show git sync status, desktop/mobile versions, tags, releases, and recent runs
  --status [run-id]          Inspect a lunacode-release.yml run (defaults to latest run)
  (default)                  Dispatch .github/workflows/lunacode-release.yml via gh workflow run

Dispatch options:
  --ref <branch>             Git ref/branch to build (default: lunacode)
  --allow-main               Allow dispatching against main (refused by default)
  --version <ver>            Override desktop version (e.g. 0.1.11 or 0.1.11-luna.1)
  --publish                  Publish a GitHub Release (publish_release=true)
  --no-publish               Upload Actions artifacts only (publish_release=false, default)
  --prerelease               Mark GitHub Release as prerelease (prerelease=true)
  --platforms <csv>          Aliases: default, all, all+mac-x64, desktop, mobile
                             Tokens: mac-arm64, mac-x64, linux-x64, win-x64, android, ios
                             (default: mac-arm64,linux-x64,win-x64,android,ios)
  --dry-run                  Print resolved parameters and gh command without dispatching
  -h, --help                 Show this help text
EOF
}

die() {
  printf '[lunacode-github-release] ERROR: %s\n' "$*" >&2
  exit 1
}

run_gh() {
  if gh "$@"; then
    return 0
  fi
  if [[ -z "${HTTPS_PROXY:-}" && -z "${HTTP_PROXY:-}" && -z "${https_proxy:-}" && -z "${http_proxy:-}" ]]; then
    HTTPS_PROXY="$FALLBACK_PROXY" HTTP_PROXY="$FALLBACK_PROXY" gh "$@"
    return $?
  fi
  return 1
}

parse_desktop_version() {
  local pkg="$REPO_ROOT/apps/desktop/package.json"
  if [[ ! -f "$pkg" ]]; then
    echo "unknown"
    return
  fi
  if command -v jq >/dev/null 2>&1; then
    jq -r '.version // "unknown"' "$pkg"
  else
    sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' "$pkg" | head -n 1
  fi
}

parse_mobile_version() {
  local cfg="$REPO_ROOT/apps/mobile/app.config.ts"
  if [[ ! -f "$cfg" ]]; then
    echo "unknown"
    return
  fi
  local ver
  ver="$(sed -nE 's/.*T3CODE_MOBILE_VERSION[[:space:]]*\?\?[[:space:]]*"([^"]+)".*/\1/p' "$cfg" | head -n 1 || true)"
  if [[ -n "$ver" ]]; then
    echo "$ver"
  else
    echo "unknown"
  fi
}

inspect_state() {
  local branch dirty_count ahead_behind desktop_ver mobile_ver local_tags remote_tags releases runs
  branch="$(git -C "$REPO_ROOT" branch --show-current 2>/dev/null || echo "detached")"
  dirty_count="$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no 2>/dev/null | wc -l | tr -d ' ')"

  if git -C "$REPO_ROOT" rev-parse --verify origin/lunacode >/dev/null 2>&1; then
    local counts
    counts="$(git -C "$REPO_ROOT" rev-list --left-right --count origin/lunacode...HEAD 2>/dev/null || echo "0 0")"
    ahead_behind="$(awk '{printf "behind=%s ahead=%s", $1, $2}' <<<"$counts")"
  else
    ahead_behind="origin/lunacode=missing"
  fi

  desktop_ver="$(parse_desktop_version)"
  mobile_ver="$(parse_mobile_version)"

  printf '=== LunaCode GitHub Release Preflight (%s) ===\n' "$REPO"
  printf 'Branch:               %s (%s, modified tracked files: %s)\n' "$branch" "$ahead_behind" "$dirty_count"
  printf 'Desktop version:      %s (apps/desktop/package.json)\n' "$desktop_ver"
  printf 'Mobile version:       %s (apps/mobile/app.config.ts)\n' "$mobile_ver"

  printf '\n--- Local lunacode-v* tags (latest 5) ---\n'
  local_tags="$(git -C "$REPO_ROOT" tag -l 'lunacode-v*' --sort=-v:refname 2>/dev/null | head -n 5 || true)"
  if [[ -n "$local_tags" ]]; then
    printf '%s\n' "$local_tags"
  else
    echo "(none)"
  fi

  printf '\n--- Remote lunacode-v* tags (latest 5) ---\n'
  remote_tags="$(git -C "$REPO_ROOT" ls-remote --tags origin 'refs/tags/lunacode-v*' 2>/dev/null \
    || HTTPS_PROXY="$FALLBACK_PROXY" HTTP_PROXY="$FALLBACK_PROXY" git -C "$REPO_ROOT" ls-remote --tags origin 'refs/tags/lunacode-v*' 2>/dev/null \
    || true)"
  remote_tags="$(printf '%s\n' "$remote_tags" | awk '{print $2}' | sed 's|refs/tags/||' | grep -v '\^{}$' | sort -rV | head -n 5 || true)"
  if [[ -n "$remote_tags" ]]; then
    printf '%s\n' "$remote_tags"
  else
    echo "(none)"
  fi

  printf '\n--- GitHub Releases (latest 5) ---\n'
  releases="$(run_gh release list -R "$REPO" --limit 5 2>/dev/null || true)"
  if [[ -n "$releases" ]]; then
    printf '%s\n' "$releases"
  else
    echo "(none)"
  fi

  printf '\n--- Recent %s runs (latest 3) ---\n' "$WORKFLOW"
  runs="$(run_gh run list -R "$REPO" --workflow "$WORKFLOW" --limit 3 2>/dev/null || true)"
  if [[ -n "$runs" ]]; then
    printf '%s\n' "$runs"
  else
    echo "(none)"
  fi
}

show_status() {
  local run_id="${1:-}"
  if [[ -z "$run_id" ]]; then
    if command -v jq >/dev/null 2>&1; then
      run_id="$(run_gh run list -R "$REPO" --workflow "$WORKFLOW" --limit 1 --json databaseId --jq '.[0].databaseId // ""')"
    else
      run_id="$(run_gh run list -R "$REPO" --workflow "$WORKFLOW" --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)"
    fi
    [[ -n "$run_id" ]] || die "No runs found for $WORKFLOW in $REPO."
  fi

  local payload
  payload="$(run_gh run view "$run_id" -R "$REPO" --json databaseId,status,conclusion,url,headBranch,event,createdAt,jobs)"
  if command -v jq >/dev/null 2>&1; then
    printf '%s\n' "$payload" | jq '{
      id: .databaseId,
      status: .status,
      conclusion: (if .conclusion == "" then null else .conclusion end),
      branch: .headBranch,
      event: .event,
      createdAt: .createdAt,
      url: .url,
      jobs: [.jobs[] | {name: .name, status: .status, conclusion: (if .conclusion == "" then null else .conclusion end)}]
    }'
  else
    printf '%s\n' "$payload"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --inspect)
      MODE="inspect"
      shift
      ;;
    --status)
      MODE="status"
      if [[ $# -gt 1 && "$2" != -* ]]; then
        STATUS_RUN_ID="$2"
        shift 2
      else
        shift
      fi
      ;;
    --ref)
      [[ $# -gt 1 ]] || die "Missing value for --ref"
      REF="$2"
      shift 2
      ;;
    --allow-main)
      ALLOW_MAIN=1
      shift
      ;;
    --version)
      [[ $# -gt 1 ]] || die "Missing value for --version"
      VERSION="$2"
      shift 2
      ;;
    --publish)
      PUBLISH_RELEASE="true"
      shift
      ;;
    --no-publish)
      PUBLISH_RELEASE="false"
      shift
      ;;
    --prerelease)
      PRERELEASE="true"
      shift
      ;;
    --platforms)
      [[ $# -gt 1 ]] || die "Missing value for --platforms"
      PLATFORMS="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1 (use --help for usage)"
      ;;
  esac
done

case "$MODE" in
  inspect)
    inspect_state
    exit 0
    ;;
  status)
    show_status "$STATUS_RUN_ID"
    exit 0
    ;;
esac

if [[ "$REF" == "main" && "$ALLOW_MAIN" -ne 1 ]]; then
  die "Refusing to dispatch against 'main' (read-only upstream mirror). Use --ref lunacode or pass --allow-main to override."
fi

if [[ -n "$VERSION" ]]; then
  VERSION="${VERSION#lunacode-v}"
  VERSION="${VERSION#v}"
  if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
    die "Invalid version '$VERSION'. Expected semver like 0.1.11 or 0.1.11-luna.1"
  fi
fi

BUILD_MAC_ARM64="false"
BUILD_MAC_X64="false"
BUILD_LINUX_X64="false"
BUILD_WIN_X64="false"
BUILD_ANDROID_APK="false"
BUILD_IOS_IPA="false"

add_platform() {
  case "$1" in
    default|all)
      BUILD_MAC_ARM64="true"
      BUILD_LINUX_X64="true"
      BUILD_WIN_X64="true"
      BUILD_ANDROID_APK="true"
      BUILD_IOS_IPA="true"
      ;;
    all+mac-x64)
      BUILD_MAC_ARM64="true"
      BUILD_MAC_X64="true"
      BUILD_LINUX_X64="true"
      BUILD_WIN_X64="true"
      BUILD_ANDROID_APK="true"
      BUILD_IOS_IPA="true"
      ;;
    desktop)
      BUILD_MAC_ARM64="true"
      BUILD_LINUX_X64="true"
      BUILD_WIN_X64="true"
      ;;
    mobile)
      BUILD_ANDROID_APK="true"
      BUILD_IOS_IPA="true"
      ;;
    mac-arm64)
      BUILD_MAC_ARM64="true"
      ;;
    mac-x64)
      BUILD_MAC_X64="true"
      ;;
    linux-x64)
      BUILD_LINUX_X64="true"
      ;;
    win-x64)
      BUILD_WIN_X64="true"
      ;;
    android)
      BUILD_ANDROID_APK="true"
      ;;
    ios)
      BUILD_IOS_IPA="true"
      ;;
    "")
      ;;
    *)
      die "Unknown platform token '$1'. Valid tokens: default, all, all+mac-x64, desktop, mobile, mac-arm64, mac-x64, linux-x64, win-x64, android, ios"
      ;;
  esac
}

IFS=',' read -r -a platform_tokens <<<"$PLATFORMS"
for token in "${platform_tokens[@]}"; do
  trimmed="${token#"${token%%[![:space:]]*}"}"
  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
  add_platform "$trimmed"
done

if [[ "$BUILD_MAC_ARM64" != "true" && "$BUILD_MAC_X64" != "true" && "$BUILD_LINUX_X64" != "true" && "$BUILD_WIN_X64" != "true" && "$BUILD_ANDROID_APK" != "true" && "$BUILD_IOS_IPA" != "true" ]]; then
  die "No valid target platform enabled from --platforms '$PLATFORMS'."
fi

resolved_version="${VERSION:-$(parse_desktop_version)}"

cmd=(
  gh workflow run "$WORKFLOW"
  -R "$REPO"
  --ref "$REF"
)

if [[ -n "$VERSION" ]]; then
  cmd+=(-f "version=$VERSION")
fi

cmd+=(
  -f "publish_release=$PUBLISH_RELEASE"
  -f "prerelease=$PRERELEASE"
  -f "build_mac_arm64=$BUILD_MAC_ARM64"
  -f "build_mac_x64=$BUILD_MAC_X64"
  -f "build_linux_x64=$BUILD_LINUX_X64"
  -f "build_win_x64=$BUILD_WIN_X64"
  -f "build_android_apk=$BUILD_ANDROID_APK"
  -f "build_ios_ipa=$BUILD_IOS_IPA"
)

printf 'Repo:            %s\n' "$REPO"
printf 'Workflow:        %s\n' "$WORKFLOW"
printf 'Ref:             %s\n' "$REF"
printf 'Version:         %s%s\n' "$resolved_version" "$([[ -z "$VERSION" ]] && echo ' (from apps/desktop/package.json)' || echo ' (override)')"
printf 'publish_release: %s\n' "$PUBLISH_RELEASE"
printf 'prerelease:      %s\n' "$PRERELEASE"
printf 'Targets:         mac-arm64=%s mac-x64=%s linux-x64=%s win-x64=%s android=%s ios=%s\n' \
  "$BUILD_MAC_ARM64" "$BUILD_MAC_X64" "$BUILD_LINUX_X64" "$BUILD_WIN_X64" "$BUILD_ANDROID_APK" "$BUILD_IOS_IPA"

if [[ "$DRY_RUN" -eq 1 ]]; then
  printf 'Command:        '
  printf ' %q' "${cmd[@]}"
  printf '\n'
  exit 0
fi

run_gh "${cmd[@]:1}"
