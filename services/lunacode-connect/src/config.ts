import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface ApnsPushConfig {
  readonly keyId: string;
  readonly teamId: string;
  readonly bundleId: string;
  readonly privateKeyPem: string;
  readonly useSandbox: boolean;
}

export interface FcmPushConfig {
  readonly projectId: string;
  readonly clientEmail: string;
  readonly privateKeyPem: string;
}

export interface ConnectConfig {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  readonly sqlitePath: string;
  readonly keyFilePath: string;
  readonly webDistDir: string | null;
  readonly defaultUserMaxTunnels: number;
  readonly publicOrigin: string;
  readonly tunnelWildcardDomain: string | undefined;
  readonly tunnelSingleDomain: string | undefined;
  readonly tunnelBaseScheme: "https" | "http";
  readonly tunnelPublicPort: string;
  readonly allowRegistration: boolean;
  readonly allowedEmails: ReadonlySet<string>;
  readonly adminEmails: ReadonlySet<string>;
  readonly adminEmail: string | undefined;
  readonly adminPassword: string | undefined;
  readonly corsAllowedOrigins: ReadonlyArray<string>;
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
  readonly sessionTtlSeconds: number;
  readonly dpopTokenTtlSeconds: number;
  readonly mintPrivateKeyPem: string | undefined;
  readonly mintPublicKeyPem: string | undefined;
  readonly apns: ApnsPushConfig | null;
  readonly fcm: FcmPushConfig | null;
}

function trimNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOrigin(raw: string): string {
  const parsed = new URL(raw);
  return parsed.origin;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return fallback;
}

function loadApnsConfig(env: NodeJS.ProcessEnv): ApnsPushConfig | null {
  const keyId = trimNonEmpty(env.APNS_KEY_ID);
  const teamId = trimNonEmpty(env.APNS_TEAM_ID);
  if (!keyId || !teamId) return null;

  let privateKeyPem = trimNonEmpty(env.APNS_PRIVATE_KEY_P8)?.replace(/\\n/gu, "\n");
  if (!privateKeyPem) {
    const keyPath = trimNonEmpty(env.APNS_PRIVATE_KEY_PATH);
    if (keyPath && NodeFS.existsSync(keyPath)) {
      privateKeyPem = trimNonEmpty(NodeFS.readFileSync(keyPath, "utf8"))?.replace(/\\n/gu, "\n");
    }
  }
  if (!privateKeyPem) return null;

  return {
    keyId,
    teamId,
    bundleId: trimNonEmpty(env.APNS_BUNDLE_ID) ?? "com.nidao003.lunacode.mobile",
    privateKeyPem,
    useSandbox: parseBoolean(env.APNS_USE_SANDBOX, false),
  };
}

function loadFcmConfig(env: NodeJS.ProcessEnv): FcmPushConfig | null {
  let rawJson = trimNonEmpty(env.FCM_SERVICE_ACCOUNT_JSON);
  if (!rawJson) {
    const jsonPath = trimNonEmpty(env.FCM_SERVICE_ACCOUNT_PATH);
    if (jsonPath && NodeFS.existsSync(jsonPath)) {
      rawJson = trimNonEmpty(NodeFS.readFileSync(jsonPath, "utf8"));
    }
  }
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    const projectId = trimNonEmpty(
      typeof parsed.project_id === "string" ? parsed.project_id : undefined,
    );
    const clientEmail = trimNonEmpty(
      typeof parsed.client_email === "string" ? parsed.client_email : undefined,
    );
    const privateKeyPem = trimNonEmpty(
      typeof parsed.private_key === "string" ? parsed.private_key : undefined,
    )?.replace(/\\n/gu, "\n");
    if (!projectId || !clientEmail || !privateKeyPem) return null;
    return { projectId, clientEmail, privateKeyPem };
  } catch {
    return null;
  }
}

export function loadConnectConfig(env: NodeJS.ProcessEnv = process.env): ConnectConfig {
  const host = trimNonEmpty(env.HOST) ?? "0.0.0.0";
  const port = parsePositiveInt(env.PORT, 8787);
  const dataDir = NodePath.resolve(trimNonEmpty(env.DATA_DIR) ?? "./data");
  const webDistRaw = trimNonEmpty(env.WEB_DIST_DIR);
  const webDistDir = webDistRaw ? NodePath.resolve(webDistRaw) : null;
  const defaultUserMaxTunnels = parseNonNegativeInt(env.DEFAULT_USER_MAX_TUNNELS, 3);
  const publicOrigin = normalizeOrigin(
    trimNonEmpty(env.PUBLIC_ORIGIN) ?? `http://127.0.0.1:${port}`,
  );
  const parsedPublic = new URL(publicOrigin);
  const inferredScheme = parsedPublic.protocol === "http:" ? "http" : "https";
  const tunnelSchemeRaw = trimNonEmpty(env.TUNNEL_BASE_SCHEME)?.toLowerCase();
  const tunnelBaseScheme =
    tunnelSchemeRaw === "http" || tunnelSchemeRaw === "https" ? tunnelSchemeRaw : inferredScheme;
  const rawPublicPort = trimNonEmpty(env.TUNNEL_PUBLIC_PORT) ?? parsedPublic.port;
  const tunnelPublicPort =
    (tunnelBaseScheme === "https" && rawPublicPort === "443") ||
    (tunnelBaseScheme === "http" && rawPublicPort === "80")
      ? ""
      : rawPublicPort;
  const tunnelWildcardDomain = trimNonEmpty(env.TUNNEL_WILDCARD_DOMAIN)
    ?.replace(/^\*\./u, "")
    .toLowerCase();
  const tunnelSingleDomain = trimNonEmpty(env.TUNNEL_SINGLE_DOMAIN)?.toLowerCase();
  const allowedEmails = new Set(
    (env.ALLOWED_EMAILS ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
  const adminEmails = new Set(
    (env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
  const adminEmail = trimNonEmpty(env.ADMIN_EMAIL)?.toLowerCase();
  const adminPassword = trimNonEmpty(env.ADMIN_PASSWORD);
  const corsAllowedOrigins = (env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return {
    host,
    port,
    dataDir,
    sqlitePath: NodePath.join(dataDir, "connect.sqlite"),
    keyFilePath: NodePath.join(dataDir, "mint-ed25519.json"),
    webDistDir,
    defaultUserMaxTunnels,
    publicOrigin,
    tunnelWildcardDomain,
    tunnelSingleDomain,
    tunnelBaseScheme,
    tunnelPublicPort,
    allowRegistration: parseBoolean(env.ALLOW_REGISTRATION, true),
    allowedEmails,
    adminEmails,
    adminEmail,
    adminPassword,
    corsAllowedOrigins,
    accessTokenTtlSeconds: parsePositiveInt(env.ACCESS_TOKEN_TTL_SEC, 900),
    refreshTokenTtlSeconds: parsePositiveInt(env.REFRESH_TOKEN_TTL_SEC, 2_592_000),
    sessionTtlSeconds: parsePositiveInt(env.SESSION_TTL_SEC, 2_592_000),
    dpopTokenTtlSeconds: parsePositiveInt(env.DPOP_TOKEN_TTL_SEC, 1_800),
    mintPrivateKeyPem: trimNonEmpty(env.MINT_PRIVATE_KEY_PEM)?.replace(/\\n/gu, "\n"),
    mintPublicKeyPem: trimNonEmpty(env.MINT_PUBLIC_KEY_PEM)?.replace(/\\n/gu, "\n"),
    apns: loadApnsConfig(env),
    fcm: loadFcmConfig(env),
  };
}
