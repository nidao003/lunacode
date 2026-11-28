# `@lunacode/connect` — Self-Hosted Backend & Relay Service

<p>
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

Zero-dependency containerized backend (Node.js 22 + built-in `node:sqlite`) providing everything required to run LunaCode remote login, relay routing, mobile notifications, and browser remote access on your own infrastructure:

- **Accounts & Security:** Email/password registration & login, persistent sessions, EdDSA (`Ed25519`) JWT signing & JWKS (`/.well-known/jwks.json`), self-service profile/password/session revocation endpoints (`/api/auth/account`, `/api/auth/profile`, `/api/auth/change-password`, `/api/auth/revoke-other-sessions`).
- **OAuth2 & CLI:** OAuth2 PKCE (`/oauth/authorize`, `/connect`) and headless Device Code (`/oauth/device/code`) authorization flows for LunaCode CLI.
- **Relay Control Plane (`v1`):** Compatible with `@t3tools/contracts/relay` (`DPoP` proofs, environment link challenges, connect/status minting, environment link preferences).
- **Built-in Binary Multiplexed `"t3_relay"` Tunnel Gateway:** Outbound WebSocket tunnel requiring zero `cloudflared` binary or port forwarding on your workstation. Supports both:
  - **Single-domain path-prefix mode (default):** `https://<your-domain>[:port]/t/<slug>/` — works with one domain and one TLS certificate.
  - **Wildcard subdomain mode (optional):** `https://env-<16hex>.<wildcard-domain>[:port]/` — unlocks Guest Links, MCP OAuth (`Use in another app`), and PeerLinks.
- **Webhooks & Native Push Notifications:** `/v1/hooks/:endpointKey/:hookId/:token` ingress with 24-hour offline hold & replay queue, plus HTTP/2 APNs (iOS alerts + Live Activities), Android FCM HTTP v1, and Expo Push fallback.
- **Bundled Web SPA & `/admin` Super-Admin Console:** Serves `WEB_DIST_DIR=/app/web-dist` (`/` login portal, `/admin`, `/pair`, `/approve-agent`, `/login`) and provides live user quota (`maxTunnels`) and feature permission controls (`managedTunnels`, `webhooks`, `mobilePush`).

---

## 1. Docker Hub Image (Recommended)

Official multi-arch images (`linux/amd64` and `linux/arm64`) are published to Docker Hub:

```bash
docker pull nidao008/lunacode-connect:latest
# Or pin a release tag:
docker pull nidao008/lunacode-connect:0.1.13
```

### Quick Start with Docker Compose / `deploy.sh`

```bash
cd services/lunacode-connect
cp .env.example .env
```

Edit `.env` to match your domain and TLS port:

```dotenv
LUNACODE_BIND_HOST=0.0.0.0
LUNACODE_HOST_PORT=8787

PUBLIC_ORIGIN=https://connect.example.com:8443
TUNNEL_BASE_SCHEME=https
TUNNEL_PUBLIC_PORT=8443

# Leave empty for single-domain `/t/<slug>/` routing, or set e.g. `example.com` for wildcard subdomains:
TUNNEL_WILDCARD_DOMAIN=

ALLOW_REGISTRATION=true
ADMIN_EMAILS=admin@example.com
```

Start and verify healthcheck:

```bash
bash scripts/deploy.sh --pull
# Or directly:
# docker compose up -d
# curl -fsS http://127.0.0.1:8787/health
```

Useful management commands:

```bash
bash scripts/deploy.sh --logs   # Tail logs
bash scripts/deploy.sh --down   # Stop container (keeps persistent /data volume)
```

---

## 2. Building Your Own Image & Offline Packaging

Use [`scripts/build-image.sh`](./scripts/build-image.sh) from the repository root. It automatically builds `apps/web` into `apps/web/dist`, stages it into `web-dist/` during the Docker build, and cleans up temporary staged files automatically.

### Build & Load Single-Arch Image Locally

```bash
bash services/lunacode-connect/scripts/build-image.sh --load
```

### Export Offline `.tar.gz` Archive (Air-Gapped / Manual Upload)

```bash
bash services/lunacode-connect/scripts/build-image.sh \
  --platform linux/amd64 \
  --tag lunacode-connect:0.1.13 \
  --export-tar ./lunacode-connect-0.1.13-linux-amd64.tar.gz
```

On the target server:

```bash
bash services/lunacode-connect/scripts/deploy.sh --tar ./lunacode-connect-0.1.13-linux-amd64.tar.gz
```

(Or `docker load -i lunacode-connect-0.1.13-linux-amd64.tar.gz`, set `LUNACODE_CONNECT_IMAGE=lunacode-connect:0.1.13` in `.env`, then `docker compose up -d`.)

### Build & Push Multi-Arch Image to Your Docker Hub

```bash
docker login -u <your-dockerhub-username>
bash services/lunacode-connect/scripts/build-image.sh \
  --platform linux/amd64,linux/arm64 \
  --tag <your-dockerhub-username>/lunacode-connect:latest \
  --tag <your-dockerhub-username>/lunacode-connect:0.1.13 \
  --push
```

Verify the pushed manifest list:

```bash
docker buildx imagetools inspect <your-dockerhub-username>/lunacode-connect:latest
```

### Automated Docker Hub Releases via GitHub Actions

[`.github/workflows/lunacode-release.yml`](../../.github/workflows/lunacode-release.yml) automatically builds & pushes multi-arch Docker images via `docker_connect_image` when `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository secrets are configured in GitHub (`Settings -> Secrets and variables -> Actions -> Secrets`).

---

## 3. Reverse Proxy Requirements (Nginx / Caddy / 1Panel / Lucky)

Forward HTTPS traffic to container port `8787`:

- **Preserve the external port in `Host`!** In Nginx use `proxy_set_header Host $http_host;` (**never** `$host`). DPoP `htu` validation and OAuth issuer checks compare the forwarded host+port against `PUBLIC_ORIGIN`.
- Forward `X-Forwarded-Proto $scheme`, `Upgrade $http_upgrade`, and `Connection $connection_upgrade`.
- Set `proxy_buffering off;` and long timeouts (`proxy_read_timeout 3600s;`) for WebSocket tunnels.
- If `TUNNEL_WILDCARD_DOMAIN` is enabled, route both `connect.example.com` and `*.example.com` (with wildcard TLS cert) to `127.0.0.1:8787`.

Reference configurations: [`nginx.conf.example`](./nginx.conf.example) and [`Caddyfile.example`](./Caddyfile.example).

---

## 4. Environment Variables Reference

| Variable                         | Default              | Description                                                                                                                                                                                                 |
| -------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                           | `8787`               | Internal HTTP listening port                                                                                                                                                                                |
| `DATA_DIR`                       | `/data`              | SQLite database (`connect.sqlite`) and Ed25519 keypair storage                                                                                                                                              |
| `WEB_DIST_DIR`                   | `/app/web-dist`      | Directory containing built `@t3tools/web` assets                                                                                                                                                            |
| `PUBLIC_ORIGIN`                  | _(required in prod)_ | Public HTTPS URL users and clients connect to (e.g. `https://connect.example.com:8443`)                                                                                                                     |
| `TUNNEL_BASE_SCHEME`             | `https`              | Public tunnel URL scheme                                                                                                                                                                                    |
| `TUNNEL_PUBLIC_PORT`             | inherited / `443`    | Public tunnel port preserved in generated endpoints                                                                                                                                                         |
| `TUNNEL_WILDCARD_DOMAIN`         | `""`                 | Root domain for subdomain tunnels (`env-<16hex>.<domain>`); leave empty for `/t/<slug>/` path mode                                                                                                          |
| `TUNNEL_SINGLE_DOMAIN`           | `""`                 | Optional dedicated single-environment host routed directly to one linked host                                                                                                                               |
| `DEFAULT_USER_MAX_TUNNELS`       | `3`                  | Default per-user managed tunnel quota                                                                                                                                                                       |
| `ALLOW_REGISTRATION`             | `true`               | Initial registration setting (overridable live in `/admin`)                                                                                                                                                 |
| `ALLOWED_EMAILS`                 | `""`                 | Comma-separated email allowlist (overridable live in `/admin`)                                                                                                                                              |
| `ADMIN_EMAILS`                   | `""`                 | Comma-separated emails automatically granted `admin` role at startup                                                                                                                                        |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `""`                 | Optional bootstrap super-admin created at startup if absent                                                                                                                                                 |
| `CORS_ALLOWED_ORIGINS`           | `""`                 | Extra comma-separated CORS origins                                                                                                                                                                          |
| `APNS_*` / `FCM_*`               | `""`                 | Optional iOS APNs `.p8` and Android FCM Service Account JSON credentials. If omitted, native push delivery is skipped cleanly without errors (in-app awareness polling and Expo fallback continue working). |

---

## 5. Connecting LunaCode Clients & Admin Console

1. Open your browser at `https://<your-public-origin>/admin` after logging in with an admin account to configure registration policy, quotas, or manage users/devices.
2. In **LunaCode Desktop, Web, or Mobile**, open the **Login dialog** (top card) or **Settings** (`后台登录与中继服务地址` / `后台登录与中继地址`), enter `https://<your-public-origin>`, and save.
3. Link your workstation under **Settings → Environments / Tunnels** to enable remote access over `t3_relay` (automatically returning to direct LAN / `.local` whenever clients rejoin the same LAN).

---

## 6. Running Tests

```bash
node --experimental-strip-types --no-warnings --test test/connect.test.ts
```

For full protocol and migration documentation, see [`docs/lunacode-connect-plan.md`](../../docs/lunacode-connect-plan.md).
