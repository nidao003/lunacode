#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd -- "${SERVICE_DIR}/../.." && pwd)"
WEB_DIST_DIR="${REPO_ROOT}/apps/web/dist"
WEB_DIST_STAGE="${SERVICE_DIR}/web-dist"
BUILDER_NAME="lunacode-connect-builder"

MODE="load"
PLATFORMS=""
EXPORT_TAR=""
SKIP_WEB="false"
TAGS=()

usage() {
  cat <<'EOF'
Usage: build-image.sh [options]

Build, export, or push the lunacode-connect Docker image (with bundled Web SPA).

Options:
  -t, --tag <image:tag>      Image tag to build (repeatable, default: nidao008/lunacode-connect:latest)
  -p, --platform <platforms> Target platform(s), e.g. linux/amd64,linux/arm64
      --push                 Build & push multi-arch manifest to registry
      --load                 Build single-arch image and load into local Docker daemon (default)
      --export-tar <path>    Export single-arch image as a .tar.gz archive
      --skip-web             Reuse apps/web/dist without running web build
  -h, --help                 Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--tag)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 2; }
      TAGS+=("$2")
      shift 2
      ;;
    -p|--platform)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 2; }
      PLATFORMS="$2"
      shift 2
      ;;
    --push)
      MODE="push"
      shift
      ;;
    --load)
      MODE="load"
      shift
      ;;
    --export-tar)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 2; }
      MODE="tar"
      EXPORT_TAR="$2"
      shift 2
      ;;
    --skip-web)
      SKIP_WEB="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ${#TAGS[@]} -eq 0 ]]; then
  TAGS=("nidao008/lunacode-connect:latest")
fi

host_arch_platform() {
  case "$(uname -m)" in
    arm64|aarch64) echo "linux/arm64" ;;
    *) echo "linux/amd64" ;;
  esac
}

if [[ -z "$PLATFORMS" ]]; then
  if [[ "$MODE" == "push" ]]; then
    PLATFORMS="linux/amd64,linux/arm64"
  elif [[ "$MODE" == "tar" ]]; then
    PLATFORMS="linux/amd64"
  else
    PLATFORMS="$(host_arch_platform)"
  fi
fi

if [[ "$MODE" != "push" && "$PLATFORMS" == *","* ]]; then
  echo "Multi-platform build ($PLATFORMS) requires --push (Docker load/export only supports one platform)." >&2
  exit 2
fi

cleanup_web_stage() {
  mkdir -p "$WEB_DIST_STAGE"
  find "$WEB_DIST_STAGE" -mindepth 1 ! -name '.gitkeep' -delete 2>/dev/null || true
}
trap cleanup_web_stage EXIT

if [[ "$SKIP_WEB" != "true" ]]; then
  echo "[1/4] Building @t3tools/web SPA bundle..."
  (
    cd "${REPO_ROOT}/apps/web"
    vp run build
  )
fi

if [[ ! -f "${WEB_DIST_DIR}/index.html" ]]; then
  echo "Missing ${WEB_DIST_DIR}/index.html; run without --skip-web or build apps/web first." >&2
  exit 1
fi

echo "[2/4] Staging apps/web/dist into services/lunacode-connect/web-dist/..."
cleanup_web_stage
cp -R "${WEB_DIST_DIR}/." "${WEB_DIST_STAGE}/"

ensure_multiarch_builder() {
  if ! docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
    echo "Creating buildx docker-container builder: ${BUILDER_NAME}"
    docker buildx create --name "$BUILDER_NAME" --driver docker-container --bootstrap >/dev/null
  else
    docker buildx inspect --bootstrap "$BUILDER_NAME" >/dev/null
  fi
}

TAG_ARGS=()
for tag in "${TAGS[@]}"; do
  TAG_ARGS+=(-t "$tag")
done

echo "[3/4] Building Docker image (${PLATFORMS}) mode=${MODE}..."
if [[ "$MODE" == "push" ]]; then
  ensure_multiarch_builder
  docker buildx build \
    --builder "$BUILDER_NAME" \
    --platform "$PLATFORMS" \
    "${TAG_ARGS[@]}" \
    --push \
    "$SERVICE_DIR"
  echo "[4/4] Pushed multi-arch manifest(s): ${TAGS[*]}"
elif [[ "$MODE" == "tar" ]]; then
  mkdir -p "$(dirname -- "$EXPORT_TAR")"
  docker buildx build \
    --platform "$PLATFORMS" \
    "${TAG_ARGS[@]}" \
    --load \
    "$SERVICE_DIR"
  echo "[4/4] Exporting ${TAGS[0]} to ${EXPORT_TAR}..."
  docker save "${TAGS[0]}" | gzip -c > "$EXPORT_TAR"
else
  docker buildx build \
    --platform "$PLATFORMS" \
    "${TAG_ARGS[@]}" \
    --load \
    "$SERVICE_DIR"
  echo "[4/4] Loaded image locally: ${TAGS[*]}"
fi
