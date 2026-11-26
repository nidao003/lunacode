#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

ACTION="pull"
TAR_FILE=""
WAIT_HEALTH="true"

usage() {
  cat <<'EOF'
Usage: deploy.sh [options]

Deploy or upgrade lunacode-connect using Docker Compose.

Options:
      --pull             Pull image from registry and start (default)
      --tar <file.gz>    Load offline .tar.gz image first, then start
      --build            Build Docker image from local directory and start
      --down             Stop and remove container (keeps /data volume)
      --logs             Tail container logs
      --no-wait          Do not wait for /health check after starting
  -h, --help             Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pull)
      ACTION="pull"
      shift
      ;;
    --tar)
      [[ $# -ge 2 ]] || { echo "Missing value for --tar" >&2; exit 2; }
      ACTION="tar"
      TAR_FILE="$2"
      shift 2
      ;;
    --build)
      ACTION="build"
      shift
      ;;
    --down)
      ACTION="down"
      shift
      ;;
    --logs)
      ACTION="logs"
      shift
      ;;
    --no-wait)
      WAIT_HEALTH="false"
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

cd "$SERVICE_DIR"

if [[ "$ACTION" == "down" ]]; then
  docker compose down
  exit 0
fi

if [[ "$ACTION" == "logs" ]]; then
  docker compose logs -f --tail=100
  exit 0
fi

if [[ ! -f ".env" && -f ".env.example" ]]; then
  cp .env.example .env
  echo "Created ${SERVICE_DIR}/.env from .env.example. Edit PUBLIC_ORIGIN (and ADMIN_EMAILS/TUNNEL_WILDCARD_DOMAIN if needed) before public use."
fi

case "$ACTION" in
  pull)
    docker compose pull
    docker compose up -d
    ;;
  tar)
    [[ -f "$TAR_FILE" ]] || { echo "Tar archive not found: $TAR_FILE" >&2; exit 1; }
    docker load -i "$TAR_FILE"
    docker compose up -d
    ;;
  build)
    docker compose up -d --build
    ;;
esac

if [[ "$WAIT_HEALTH" != "true" ]]; then
  exit 0
fi

HOST_PORT="${LUNACODE_HOST_PORT:-8787}"
if [[ -f ".env" ]]; then
  ENV_PORT="$(grep -E '^LUNACODE_HOST_PORT=' .env | tail -n1 | cut -d= -f2- | tr -d '[:space:]' || true)"
  if [[ -n "$ENV_PORT" ]]; then
    HOST_PORT="$ENV_PORT"
  fi
fi

echo "Waiting for http://127.0.0.1:${HOST_PORT}/health ..."
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${HOST_PORT}/health" >/dev/null 2>&1; then
    echo "lunacode-connect is healthy:"
    curl -fsS "http://127.0.0.1:${HOST_PORT}/health"
    echo ""
    echo "Web / Login: http://127.0.0.1:${HOST_PORT}/login"
    echo "Admin UI:    http://127.0.0.1:${HOST_PORT}/admin"
    exit 0
  fi
  sleep 1
done

echo "lunacode-connect did not pass /health within 30s; recent logs:" >&2
docker compose logs --tail=50 >&2 || true
exit 1
