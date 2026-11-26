import type * as NodeHttp from "node:http";

import {
  authenticateUserBearerOrSession,
  extractBearerToken,
  type HttpContext,
  parseFormOrJsonBody,
  parseJsonBody,
  sendJson,
} from "./authRoutes.ts";
import type { ConnectConfig } from "./config.ts";
import {
  type MintKeyPair,
  randomToken,
  randomUuid,
  sha256Base64Url,
  sha256Hex,
  signEdDsaJwt,
  verifyDpopProof,
  verifyEdDsaJwt,
} from "./crypto.ts";
import type { ConnectDatabase, EnvironmentRow } from "./db.ts";
import { buildAgentActivityAggregate, dispatchPushForActivity } from "./pushDispatcher.ts";
import type { TunnelHub } from "./tunnelHub.ts";
import {
  deliverWebhookToEnvironment,
  HELD_WEBHOOK_TTL_MS,
  replayHeldWebhooksForEnvironment,
  sanitizeWebhookForwardHeaders,
  WEBHOOK_MAX_BODY_BYTES,
} from "./webhookRelay.ts";

const DPOP_SCOPES = ["environment:connect", "environment:status", "mobile:registration"] as const;

const RELAY_LINK_CHALLENGE_TYP = "t3-link-challenge+jwt";
const RELAY_LINK_PROOF_TYP = "t3-env-link+jwt";
const RELAY_DPOP_ACCESS_TOKEN_TYP = "t3-relay-dpop-access+jwt";
const RELAY_HEALTH_REQUEST_TYP = "t3-cloud-health+jwt";
const RELAY_HEALTH_RESPONSE_TYP = "t3-env-health+jwt";
const RELAY_MINT_REQUEST_TYP = "t3-cloud-mint+jwt";
const RELAY_MINT_RESPONSE_TYP = "t3-env-mint+jwt";
const RELAY_MANAGED_TUNNEL_RECOVERY_TYP = "t3-env-managed-tunnel-recovery+jwt";
const RELAY_ACTIVITY_PROOF_TYP = "t3-env-activity+jwt";

function buildManagedTunnelUrls(input: {
  readonly config: ConnectConfig;
  readonly tunnelSlug: string;
}): {
  readonly tunnelHost: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
} {
  const { config, tunnelSlug } = input;
  const publicHost = new URL(config.publicOrigin).hostname.toLowerCase();
  const portSuffix = config.tunnelPublicPort ? `:${config.tunnelPublicPort}` : "";
  const httpScheme = config.tunnelBaseScheme;
  const wsScheme = httpScheme === "https" ? "wss" : "ws";
  let tunnelHost = publicHost;
  let pathPrefix = "/";

  if (config.tunnelWildcardDomain) {
    tunnelHost = `${tunnelSlug}.${config.tunnelWildcardDomain}`.toLowerCase();
  } else if (config.tunnelSingleDomain && config.tunnelSingleDomain !== publicHost) {
    tunnelHost = config.tunnelSingleDomain;
  } else {
    tunnelHost = publicHost;
    pathPrefix = `/t/${tunnelSlug}/`;
  }

  return {
    tunnelHost,
    httpBaseUrl: `${httpScheme}://${tunnelHost}${portSuffix}${pathPrefix}`,
    wsBaseUrl: `${wsScheme}://${tunnelHost}${portSuffix}${pathPrefix}`,
  };
}

function normalizeIssuer(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

function sameJsonValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, idx) => sameJsonValue(item, b[idx]));
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA).filter((k) => objA[k] !== undefined);
  const keysB = Object.keys(objB).filter((k) => objB[k] !== undefined);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => Object.hasOwn(objB, k) && sameJsonValue(objA[k], objB[k]));
}

function formatClientDeviceRecord(
  raw: Record<string, unknown>,
  liveActivityRegisteredDeviceIds: ReadonlySet<string>,
) {
  const deviceId =
    typeof raw.deviceId === "string" && raw.deviceId.trim() ? raw.deviceId.trim() : "unknown";
  const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : deviceId;
  const platform = raw.platform === "android" ? "android" : "ios";
  const iosMajorVersion =
    platform === "ios" &&
    typeof raw.iosMajorVersion === "number" &&
    Number.isInteger(raw.iosMajorVersion) &&
    raw.iosMajorVersion >= 18
      ? raw.iosMajorVersion
      : platform === "ios"
        ? 18
        : null;
  const androidApiLevel =
    platform === "android" &&
    typeof raw.androidApiLevel === "number" &&
    Number.isInteger(raw.androidApiLevel)
      ? raw.androidApiLevel
      : platform === "android"
        ? null
        : undefined;
  const appVersion =
    typeof raw.appVersion === "string" && raw.appVersion.trim() ? raw.appVersion.trim() : null;
  const prefs =
    raw.preferences && typeof raw.preferences === "object"
      ? (raw.preferences as Record<string, unknown>)
      : raw.notifications && typeof raw.notifications === "object"
        ? (raw.notifications as Record<string, unknown>)
        : {};
  const notificationsEnabled =
    typeof prefs.notificationsEnabled === "boolean"
      ? prefs.notificationsEnabled
      : typeof prefs.enabled === "boolean"
        ? prefs.enabled
        : false;
  const liveActivitiesObj =
    raw.liveActivities && typeof raw.liveActivities === "object"
      ? (raw.liveActivities as Record<string, unknown>)
      : null;
  const hasPushToStart =
    typeof raw.pushToStartToken === "string" && raw.pushToStartToken.trim().length > 0;
  const liveActivitiesEnabled =
    liveActivityRegisteredDeviceIds.has(deviceId) ||
    hasPushToStart ||
    liveActivitiesObj?.enabled === true;
  const updatedAt =
    typeof raw.updatedAt === "string" && raw.updatedAt.trim()
      ? raw.updatedAt.trim()
      : new Date().toISOString();

  return {
    deviceId,
    label,
    platform,
    iosMajorVersion,
    ...(androidApiLevel !== undefined ? { androidApiLevel } : {}),
    appVersion,
    notifications: {
      enabled: notificationsEnabled,
      notifyOnApproval: prefs.notifyOnApproval !== false,
      notifyOnInput: prefs.notifyOnInput !== false,
      notifyOnCompletion: prefs.notifyOnCompletion === true,
      notifyOnFailure: prefs.notifyOnFailure !== false,
    },
    liveActivities: {
      enabled: liveActivitiesEnabled,
    },
    updatedAt,
  };
}

function allowedHtuUrls(
  config: ConnectConfig,
  req: NodeHttp.IncomingMessage,
  path: string,
): Array<string> {
  const urls = [`${normalizeIssuer(config.publicOrigin)}${path}`];
  const host = req.headers.host;
  if (typeof host === "string" && host.trim()) {
    const protoRaw = req.headers["x-forwarded-proto"];
    const proto = typeof protoRaw === "string" ? protoRaw.split(",")[0]!.trim() : "http";
    urls.push(`${proto}://${host}${path}`);
  }
  return urls;
}

function authenticateDpopClient(input: {
  readonly req: NodeHttp.IncomingMessage;
  readonly path: string;
  readonly config: ConnectConfig;
  readonly mintKeys: MintKeyPair;
  readonly db: ConnectDatabase;
  readonly requiredScope: (typeof DPOP_SCOPES)[number];
}):
  | { readonly ok: true; readonly userId: string; readonly thumbprint: string }
  | { readonly ok: false; readonly status: number; readonly error: unknown } {
  const authHeader = input.req.headers.authorization;
  if (typeof authHeader !== "string" || !/^DPoP\s+/iu.test(authHeader.trim())) {
    return { ok: false, status: 401, error: { code: "auth_invalid", reason: "missing_bearer" } };
  }
  const accessToken = authHeader
    .trim()
    .replace(/^DPoP\s+/iu, "")
    .trim();
  const issuer = normalizeIssuer(input.config.publicOrigin);
  const verifiedToken = verifyEdDsaJwt({
    publicKeyPem: input.mintKeys.publicKeyPem,
    token: accessToken,
    expectedTyp: RELAY_DPOP_ACCESS_TOKEN_TYP,
    expectedIssuer: issuer,
    expectedAudience: issuer,
    maxTokenAgeSeconds: input.config.dpopTokenTtlSeconds,
  });
  if (!verifiedToken.ok || typeof verifiedToken.claims.sub !== "string") {
    return { ok: false, status: 401, error: { code: "auth_invalid", reason: "invalid_bearer" } };
  }

  const user = input.db.findUserById(verifiedToken.claims.sub);
  if (!user || user.disabledAt !== null) {
    return { ok: false, status: 401, error: { code: "auth_invalid", reason: "account_disabled" } };
  }

  const cnf = verifiedToken.claims.cnf as { jkt?: unknown } | undefined;
  const thumbprint = typeof cnf?.jkt === "string" ? cnf.jkt : "";
  const scopes =
    typeof verifiedToken.claims.scope === "string"
      ? verifiedToken.claims.scope.split(/\s+/u).filter(Boolean)
      : [];
  if (!thumbprint || !scopes.includes(input.requiredScope)) {
    return {
      ok: false,
      status: 403,
      error: { code: "auth_invalid", reason: "insufficient_scope" },
    };
  }

  const dpopHeader =
    typeof input.req.headers.dpop === "string" ? input.req.headers.dpop : undefined;
  const nowSec = Math.floor(Date.now() / 1_000);
  const dpopResult = verifyDpopProof({
    proof: dpopHeader,
    method: input.req.method ?? "POST",
    allowedUrls: allowedHtuUrls(input.config, input.req, input.path),
    expectedThumbprint: thumbprint,
    expectedAccessToken: accessToken,
    nowEpochSeconds: nowSec,
  });
  if (!dpopResult.ok) {
    return {
      ok: false,
      status: 401,
      error: { code: "auth_invalid", reason: `dpop_${dpopResult.code}` },
    };
  }
  const notReplayed = input.db.consumeReplayGuard(
    "dpop_replays",
    dpopResult.thumbprint,
    dpopResult.jti,
    dpopResult.iat + 305,
    nowSec,
  );
  if (!notReplayed) {
    return { ok: false, status: 401, error: { code: "auth_invalid", reason: "dpop_replayed" } };
  }
  return {
    ok: true,
    userId: verifiedToken.claims.sub,
    thumbprint: dpopResult.thumbprint,
  };
}

function decodeJwtPayloadUnsafe(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return decoded && typeof decoded === "object" ? (decoded as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function dispatchToEnvironment(input: {
  readonly tunnelHub: TunnelHub;
  readonly env: EnvironmentRow;
  readonly path: string;
  readonly payload: unknown;
}): Promise<
  | { readonly ok: true; readonly status: number; readonly json: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly failure: "endpoint_request_failed" | "endpoint_response_invalid";
      readonly message: string;
      readonly status?: number;
    }
> {
  if (input.env.providerKind === "t3_relay") {
    if (!input.env.tunnelId || !input.tunnelHub.hasActiveTunnel(input.env.tunnelId)) {
      return {
        ok: false,
        failure: "endpoint_request_failed",
        message: "Environment tunnel is offline.",
      };
    }
    try {
      const response = await input.tunnelHub.dispatchInternalHttp(input.env.tunnelId, {
        method: "POST",
        url: input.path,
        headers: {
          "content-type": "application/json",
          host: new URL(input.env.httpBaseUrl).host,
        },
        body: JSON.stringify(input.payload),
        timeoutMs: 12_000,
      });
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(response.body.toString("utf8"));
      } catch {
        parsed = null;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return {
          ok: false,
          failure: "endpoint_request_failed",
          message: `Environment returned HTTP ${response.statusCode}.`,
          status: response.statusCode,
        };
      }
      if (!parsed || typeof parsed !== "object") {
        return {
          ok: false,
          failure: "endpoint_response_invalid",
          message: "Environment returned invalid JSON.",
          status: response.statusCode,
        };
      }
      return { ok: true, status: response.statusCode, json: parsed as Record<string, unknown> };
    } catch (error) {
      return {
        ok: false,
        failure: "endpoint_request_failed",
        message: error instanceof Error ? error.message : "Tunnel dispatch failed.",
      };
    }
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const targetUrl = new URL(input.path, input.env.httpBaseUrl).toString();
      const response = await fetch(targetUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input.payload),
        redirect: "manual",
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        return {
          ok: false,
          failure: "endpoint_request_failed",
          message: `Environment returned HTTP ${response.status}.`,
          status: response.status,
        };
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (!parsed || typeof parsed !== "object") {
        return {
          ok: false,
          failure: "endpoint_response_invalid",
          message: "Environment returned invalid JSON.",
          status: response.status,
        };
      }
      return { ok: true, status: response.status, json: parsed as Record<string, unknown> };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return {
      ok: false,
      failure: "endpoint_request_failed",
      message: error instanceof Error ? error.message : "Request to environment failed.",
    };
  }
}

export async function handleRelayRoute(input: {
  readonly ctx: HttpContext;
  readonly config: ConnectConfig;
  readonly mintKeys: MintKeyPair;
  readonly db: ConnectDatabase;
  readonly tunnelHub: TunnelHub;
}): Promise<boolean> {
  const { ctx, config, mintKeys, db, tunnelHub } = input;
  const { req, res, url, body } = ctx;
  const method = req.method ?? "GET";
  const path = url.pathname;
  const issuer = normalizeIssuer(config.publicOrigin);

  if (method === "GET" && path === "/health") {
    sendJson(res, 200, { ok: true, service: "relay" });
    return true;
  }

  if (method === "GET" && path === "/.well-known/oauth-authorization-server") {
    sendJson(res, 200, {
      issuer,
      token_endpoint: `${issuer}/v1/client/dpop-token`,
      grant_types_supported: ["urn:ietf:params:oauth:grant-type:token-exchange"],
      token_endpoint_auth_methods_supported: ["none"],
      dpop_signing_alg_values_supported: ["ES256"],
      scopes_supported: DPOP_SCOPES,
    });
    return true;
  }

  if (method === "GET" && path === "/.well-known/oauth-protected-resource") {
    sendJson(res, 200, {
      resource: issuer,
      authorization_servers: [issuer],
      scopes_supported: DPOP_SCOPES,
      dpop_bound_access_tokens_required: true,
      dpop_signing_alg_values_supported: ["ES256"],
    });
    return true;
  }

  if (method === "POST" && path === "/v1/client/dpop-token") {
    const form = parseFormOrJsonBody(req, body);
    const subjectToken = form.subject_token ?? "";
    const resource = form.resource ? normalizeIssuer(form.resource) : "";
    const clientId = form.client_id ?? "";
    const rawScope = form.scope ?? "";
    if (
      form.grant_type !== "urn:ietf:params:oauth:grant-type:token-exchange" ||
      form.subject_token_type !== "urn:ietf:params:oauth:token-type:jwt" ||
      form.requested_token_type !== "urn:ietf:params:oauth:token-type:access_token" ||
      resource !== issuer ||
      (clientId !== "t3-mobile" && clientId !== "t3-web")
    ) {
      sendJson(res, 401, { code: "auth_invalid", reason: "invalid_request" });
      return true;
    }

    const requestedScopes = rawScope
      .split(/\s+/u)
      .filter((entry): entry is (typeof DPOP_SCOPES)[number] =>
        (DPOP_SCOPES as ReadonlyArray<string>).includes(entry),
      );
    if (requestedScopes.length === 0) {
      sendJson(res, 401, { code: "auth_invalid", reason: "invalid_scope" });
      return true;
    }

    const verifiedUserJwt = verifyEdDsaJwt({
      publicKeyPem: mintKeys.publicKeyPem,
      token: subjectToken,
      expectedTyp: "JWT",
      expectedIssuer: issuer,
      expectedAudience: issuer,
    });
    if (!verifiedUserJwt.ok || typeof verifiedUserJwt.claims.sub !== "string") {
      sendJson(res, 401, { code: "auth_invalid", reason: "invalid_bearer" });
      return true;
    }
    const user = db.findUserById(verifiedUserJwt.claims.sub);
    if (!user || user.disabledAt !== null) {
      sendJson(res, 401, {
        code: "auth_invalid",
        reason: user ? "account_disabled" : "invalid_bearer",
      });
      return true;
    }

    const dpopHeader = typeof req.headers.dpop === "string" ? req.headers.dpop : undefined;
    const nowSec = Math.floor(Date.now() / 1_000);
    const dpop = verifyDpopProof({
      proof: dpopHeader,
      method: "POST",
      allowedUrls: allowedHtuUrls(config, req, path),
      nowEpochSeconds: nowSec,
    });
    if (!dpop.ok) {
      sendJson(res, 401, { code: "auth_invalid", reason: `dpop_${dpop.code}` });
      return true;
    }
    if (!db.consumeReplayGuard("dpop_replays", dpop.thumbprint, dpop.jti, dpop.iat + 305, nowSec)) {
      sendJson(res, 401, { code: "auth_invalid", reason: "dpop_replayed" });
      return true;
    }

    const accessToken = signEdDsaJwt({
      privateKeyPem: mintKeys.privateKeyPem,
      typ: RELAY_DPOP_ACCESS_TOKEN_TYP,
      kid: mintKeys.kid,
      payload: {
        iss: issuer,
        aud: issuer,
        sub: user.id,
        jti: randomUuid(),
        iat: nowSec,
        exp: nowSec + config.dpopTokenTtlSeconds,
        client_id: clientId,
        scope: requestedScopes.join(" "),
        cnf: { jkt: dpop.thumbprint },
      },
    });
    sendJson(res, 200, {
      access_token: accessToken,
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      token_type: "DPoP",
      expires_in: config.dpopTokenTtlSeconds,
      scope: requestedScopes.join(" "),
    });
    return true;
  }

  if (method === "GET" && path === "/v1/environments") {
    const user = authenticateUserBearerOrSession({ req, config, mintKeys, db });
    if (!user) {
      sendJson(res, 401, { code: "auth_invalid", reason: "invalid_bearer" });
      return true;
    }
    const environments = db.listEnvironmentsForUser(user.id).map((row) => ({
      environmentId: row.environmentId,
      label: row.label,
      endpoint: {
        httpBaseUrl: row.httpBaseUrl,
        wsBaseUrl: row.wsBaseUrl,
        providerKind: row.providerKind,
      },
      linkedAt: row.linkedAt,
    }));
    sendJson(res, 200, { environments });
    return true;
  }

  if (method === "GET" && path === "/v1/client/devices") {
    const user = authenticateUserBearerOrSession({ req, config, mintKeys, db });
    if (!user) {
      sendJson(res, 401, { code: "auth_invalid", reason: "invalid_bearer" });
      return true;
    }
    const liveActivityDeviceIds = new Set(
      db.listLiveActivityTokensForUser(user.id).map((entry) => entry.deviceId),
    );
    const registered = db.listDevicesForUser(user.id);
    sendJson(res, 200, {
      devices: registered
        .map((device) => formatClientDeviceRecord(device, liveActivityDeviceIds))
        .filter((device) => device.platform === "ios"),
    });
    return true;
  }

  if (method === "GET" && path === "/v2/client/devices") {
    const user = authenticateUserBearerOrSession({ req, config, mintKeys, db });
    if (!user) {
      sendJson(res, 401, { code: "auth_invalid", reason: "invalid_bearer" });
      return true;
    }
    const liveActivityDeviceIds = new Set(
      db.listLiveActivityTokensForUser(user.id).map((entry) => entry.deviceId),
    );
    sendJson(res, 200, {
      devices: db
        .listDevicesForUser(user.id)
        .map((device) => formatClientDeviceRecord(device, liveActivityDeviceIds)),
    });
    return true;
  }

  if (method === "GET" && path === "/v1/client/t3chat-link") {
    const user = authenticateUserBearerOrSession({ req, config, mintKeys, db });
    if (!user) {
      sendJson(res, 401, { code: "auth_invalid", reason: "invalid_bearer" });
      return true;
    }
    sendJson(res, 200, {
      available: false,
      link: null,
      maxTunnelsOverride: user.permissions.managedTunnels ? user.maxTunnels : 0,
    });
    return true;
  }

  if (method === "POST" && path === "/v1/client/environment-link-challenges") {
    const user = authenticateUserBearerOrSession({ req, config, mintKeys, db });
    if (!user) {
      sendJson(res, 401, { code: "auth_invalid", reason: "invalid_bearer" });
      return true;
    }
    const payload = parseJsonBody(body);
    if (!payload) {
      sendJson(res, 400, { code: "invalid_request" });
      return true;
    }
    const nowSec = Math.floor(Date.now() / 1_000);
    const expSec = nowSec + 300;
    const challenge = signEdDsaJwt({
      privateKeyPem: mintKeys.privateKeyPem,
      typ: RELAY_LINK_CHALLENGE_TYP,
      kid: mintKeys.kid,
      payload: {
        kind: "environment_link_challenge",
        iss: issuer,
        aud: issuer,
        sub: user.id,
        jti: randomUuid(),
        iat: nowSec,
        exp: expSec,
        notificationsEnabled: payload.notificationsEnabled === true,
        liveActivitiesEnabled: payload.liveActivitiesEnabled === true,
        managedTunnelsEnabled: payload.managedTunnelsEnabled === true,
      },
    });
    sendJson(res, 200, { challenge, expiresAt: new Date(expSec * 1_000).toISOString() });
    return true;
  }

  if (method === "POST" && path === "/v1/client/environment-links") {
    const user = authenticateUserBearerOrSession({ req, config, mintKeys, db });
    if (!user) {
      sendJson(res, 401, { code: "auth_invalid", reason: "invalid_bearer" });
      return true;
    }
    const payload = parseJsonBody(body);
    const proof = typeof payload?.proof === "string" ? payload.proof : "";
    const managedTunnelsEnabled = payload?.managedTunnelsEnabled === true;
    const notificationsEnabled = payload?.notificationsEnabled === true;
    const liveActivitiesEnabled = payload?.liveActivitiesEnabled === true;
    const unsafeClaims = decodeJwtPayloadUnsafe(proof);
    const envPublicKey =
      typeof unsafeClaims?.environmentPublicKey === "string"
        ? unsafeClaims.environmentPublicKey
        : "";
    const claimedEnvId =
      typeof unsafeClaims?.environmentId === "string" ? unsafeClaims.environmentId : "";
    if (!proof || !envPublicKey || !claimedEnvId) {
      sendJson(res, 400, {
        code: "environment_link_proof_invalid",
        reason: "invalid_signature_or_scope",
      });
      return true;
    }

    const verifiedProof = verifyEdDsaJwt({
      publicKeyPem: envPublicKey,
      token: proof,
      expectedTyp: RELAY_LINK_PROOF_TYP,
      expectedIssuer: `t3-env:${claimedEnvId}`,
      expectedAudience: issuer,
      maxTokenAgeSeconds: 300,
    });
    if (!verifiedProof.ok) {
      sendJson(res, 400, {
        code: "environment_link_proof_invalid",
        reason:
          verifiedProof.reason === "expired" || verifiedProof.reason === "max_age_exceeded"
            ? "challenge_invalid"
            : "invalid_signature_or_scope",
      });
      return true;
    }
    const claims = verifiedProof.claims;
    if (
      claims.environmentId !== claimedEnvId ||
      claims.environmentPublicKey !== envPublicKey ||
      claims.sub !== claimedEnvId
    ) {
      sendJson(res, 400, {
        code: "environment_link_proof_invalid",
        reason: "invalid_signature_or_scope",
      });
      return true;
    }
    const challengeToken = typeof claims.challenge === "string" ? claims.challenge : "";
    const verifiedChallenge = verifyEdDsaJwt({
      publicKeyPem: mintKeys.publicKeyPem,
      token: challengeToken,
      expectedTyp: RELAY_LINK_CHALLENGE_TYP,
      expectedIssuer: issuer,
      expectedAudience: issuer,
      maxTokenAgeSeconds: 300,
    });
    const nowSec = Math.floor(Date.now() / 1_000);
    if (
      !verifiedChallenge.ok ||
      verifiedChallenge.claims.kind !== "environment_link_challenge" ||
      verifiedChallenge.claims.sub !== user.id ||
      typeof verifiedChallenge.claims.jti !== "string" ||
      !db.consumeLinkChallengeNonce(
        verifiedChallenge.claims.jti,
        typeof verifiedChallenge.claims.exp === "number"
          ? verifiedChallenge.claims.exp
          : nowSec + 300,
        nowSec,
      )
    ) {
      sendJson(res, 400, {
        code: "environment_link_proof_invalid",
        reason: "challenge_invalid",
      });
      return true;
    }

    const descriptor = claims.descriptor as { label?: unknown } | undefined;
    const label =
      typeof descriptor?.label === "string" && descriptor.label.trim()
        ? descriptor.label.trim()
        : claimedEnvId;
    const proofEndpoint = claims.endpoint as
      | {
          httpBaseUrl?: unknown;
          wsBaseUrl?: unknown;
          providerKind?: unknown;
        }
      | undefined;
    const proofScopes = Array.isArray(claims.scopes) ? claims.scopes : [];
    if (managedTunnelsEnabled && !proofScopes.includes("managed_tunnels")) {
      sendJson(res, 400, {
        code: "environment_link_proof_invalid",
        reason: "invalid_signature_or_scope",
      });
      return true;
    }

    const existing = db.getEnvironment(claimedEnvId, user.id);
    if (managedTunnelsEnabled) {
      if (!user.permissions.managedTunnels) {
        sendJson(res, 403, {
          code: "environment_link_limit_exceeded",
          maxTunnels: 0,
          traceId: randomUuid(),
        });
        return true;
      }
      const countsAsNewManagedTunnel =
        !existing || existing.revokedAt !== null || existing.providerKind !== "t3_relay";
      if (
        countsAsNewManagedTunnel &&
        db.countActiveManagedTunnelsForUser(user.id) >= user.maxTunnels
      ) {
        sendJson(res, 403, {
          code: "environment_link_limit_exceeded",
          maxTunnels: user.maxTunnels,
          traceId: randomUuid(),
        });
        return true;
      }
    }

    const environmentCredential = `lce_${randomToken(32)}`;
    const nowIso = new Date().toISOString();

    let finalEndpoint: {
      httpBaseUrl: string;
      wsBaseUrl: string;
      providerKind: "t3_relay" | "manual";
    };
    let endpointRuntime: {
      providerKind: "t3_relay";
      connectorToken: string;
      tunnelId: string;
      tunnelName: string;
    } | null = null;
    let tunnelSlug: string | null = existing?.tunnelSlug ?? null;
    let tunnelHost: string | null = null;
    let connectorTokenHash: string | null = null;

    if (managedTunnelsEnabled) {
      const endpointKey = sha256Hex(`${user.id}:${claimedEnvId}`).slice(0, 16);
      tunnelSlug =
        existing?.tunnelSlug && /^env-[0-9a-f]{16}$/u.test(existing.tunnelSlug)
          ? existing.tunnelSlug
          : `env-${endpointKey}`;
      const urls = buildManagedTunnelUrls({ config, tunnelSlug });
      tunnelHost = urls.tunnelHost;

      const tunnelId =
        existing?.tunnelId ?? `tun_${sha256Hex(`${user.id}:${claimedEnvId}`).slice(0, 24)}`;
      const tunnelName =
        existing?.tunnelName && existing.tunnelName.endsWith(`-${endpointKey}`)
          ? existing.tunnelName
          : `lunacode-${endpointKey}`;
      const connectorToken = `lct_${randomToken(32)}`;
      connectorTokenHash = sha256Base64Url(connectorToken);
      finalEndpoint = {
        httpBaseUrl: urls.httpBaseUrl,
        wsBaseUrl: urls.wsBaseUrl,
        providerKind: "t3_relay",
      };
      endpointRuntime = {
        providerKind: "t3_relay",
        connectorToken,
        tunnelId,
        tunnelName,
      };
      if (existing?.tunnelId) {
        tunnelHub.closeTunnel(existing.tunnelId, "Environment re-linked");
      }
    } else {
      const manualHttp =
        typeof proofEndpoint?.httpBaseUrl === "string" ? proofEndpoint.httpBaseUrl : "";
      const manualWs = typeof proofEndpoint?.wsBaseUrl === "string" ? proofEndpoint.wsBaseUrl : "";
      if (!manualHttp.startsWith("https://") || !manualWs.startsWith("wss://")) {
        sendJson(res, 400, {
          code: "environment_link_proof_invalid",
          reason: "endpoint_not_secure",
        });
        return true;
      }
      finalEndpoint = {
        httpBaseUrl: manualHttp,
        wsBaseUrl: manualWs,
        providerKind: "manual",
      };
    }

    db.upsertEnvironment({
      environmentId: claimedEnvId,
      userId: user.id,
      label,
      environmentPublicKey: envPublicKey,
      environmentCredentialHash: sha256Base64Url(environmentCredential),
      providerKind: finalEndpoint.providerKind,
      httpBaseUrl: finalEndpoint.httpBaseUrl,
      wsBaseUrl: finalEndpoint.wsBaseUrl,
      tunnelId: endpointRuntime?.tunnelId ?? existing?.tunnelId ?? null,
      tunnelName: endpointRuntime?.tunnelName ?? existing?.tunnelName ?? null,
      tunnelSlug,
      tunnelHost,
      connectorTokenHash,
      holdWebhooksWhileOffline: existing?.holdWebhooksWhileOffline ?? 0,
      liveActivitiesEnabled: liveActivitiesEnabled ? 1 : 0,
      notificationsEnabled: notificationsEnabled ? 1 : 0,
      revokedAt: null,
      linkedAt: existing?.linkedAt ?? nowIso,
      updatedAt: nowIso,
    });

    sendJson(res, 200, {
      ok: true,
      cloudUserId: user.id,
      environmentId: claimedEnvId,
      endpoint: finalEndpoint,
      endpointRuntime,
      relayIssuer: issuer,
      environmentCredential,
      cloudMintPublicKey: mintKeys.publicKeyPem,
    });
    return true;
  }

  const unlinkTunnelMatch = /^\/v1\/client\/environment-links\/([^/]+)\/tunnel$/u.exec(path);
  if (method === "DELETE" && unlinkTunnelMatch) {
    const user = authenticateUserBearerOrSession({ req, config, mintKeys, db });
    if (!user) {
      sendJson(res, 401, { code: "auth_invalid", reason: "invalid_bearer" });
      return true;
    }
    const environmentId = decodeURIComponent(unlinkTunnelMatch[1]!);
    const tunnelId = db.releaseTunnelToken(environmentId, user.id);
    if (tunnelId) tunnelHub.closeTunnel(tunnelId, "Tunnel released by environment");
    sendJson(res, 200, { ok: tunnelId !== null });
    return true;
  }

  const unlinkMatch = /^\/v1\/client\/environment-links\/([^/]+)$/u.exec(path);
  if (method === "DELETE" && unlinkMatch) {
    const user = authenticateUserBearerOrSession({ req, config, mintKeys, db });
    if (!user) {
      sendJson(res, 401, { code: "auth_invalid", reason: "invalid_bearer" });
      return true;
    }
    const environmentId = decodeURIComponent(unlinkMatch[1]!);
    const tunnelId = db.revokeEnvironment(environmentId, user.id);
    if (tunnelId) tunnelHub.closeTunnel(tunnelId, "Environment unlinked");
    sendJson(res, 200, { ok: true });
    return true;
  }

  const envConnectMatch = /^\/v1\/environments\/([^/]+)\/connect$/u.exec(path);
  if (method === "POST" && envConnectMatch) {
    const auth = authenticateDpopClient({
      req,
      path,
      config,
      mintKeys,
      db,
      requiredScope: "environment:connect",
    });
    if (!auth.ok) {
      sendJson(res, auth.status, auth.error);
      return true;
    }
    const environmentId = decodeURIComponent(envConnectMatch[1]!);
    const env = db.getEnvironment(environmentId, auth.userId);
    if (!env || env.revokedAt !== null) {
      sendJson(res, 403, {
        code: "environment_connect_not_authorized",
        reason: "link_revoked",
      });
      return true;
    }
    const payload = parseJsonBody(body) ?? {};
    const requestedThumbprint =
      (typeof payload.clientProofKeyThumbprint === "string" && payload.clientProofKeyThumbprint) ||
      (typeof payload.clientKeyThumbprint === "string" && payload.clientKeyThumbprint) ||
      "";
    if (!requestedThumbprint || requestedThumbprint !== auth.thumbprint) {
      sendJson(res, 401, { code: "auth_invalid", reason: "dpop_key_mismatch" });
      return true;
    }
    const nowSec = Math.floor(Date.now() / 1_000);
    const nonce = randomToken(16);
    const proof = signEdDsaJwt({
      privateKeyPem: mintKeys.privateKeyPem,
      typ: RELAY_MINT_REQUEST_TYP,
      kid: mintKeys.kid,
      payload: {
        iss: issuer,
        aud: `t3-env:${env.environmentId}`,
        sub: env.userId,
        jti: randomUuid(),
        iat: nowSec,
        exp: nowSec + 120,
        environmentId: env.environmentId,
        clientProofKeyThumbprint: auth.thumbprint,
        cnf: { jkt: auth.thumbprint },
        ...(typeof payload.deviceId === "string" && payload.deviceId
          ? { deviceId: payload.deviceId }
          : {}),
        nonce,
        scope: ["environment:connect"],
      },
    });
    const dispatched = await dispatchToEnvironment({
      tunnelHub,
      env,
      path: "/api/t3-connect/mint-credential",
      payload: { proof },
    });
    if (!dispatched.ok) {
      sendJson(res, 502, {
        code: "environment_endpoint_unavailable",
        reason: dispatched.failure,
        endpointFailure: "connect_failed",
        ...(dispatched.status ? { endpointStatus: dispatched.status } : {}),
      });
      return true;
    }
    const credential =
      typeof dispatched.json.credential === "string" ? dispatched.json.credential : "";
    const expiresAt =
      typeof dispatched.json.expiresAt === "string" ? dispatched.json.expiresAt : "";
    const envProof = typeof dispatched.json.proof === "string" ? dispatched.json.proof : "";
    const verifiedEnvProof = verifyEdDsaJwt({
      publicKeyPem: env.environmentPublicKey,
      token: envProof,
      expectedTyp: RELAY_MINT_RESPONSE_TYP,
      expectedIssuer: `t3-env:${env.environmentId}`,
      expectedAudience: issuer,
    });
    if (
      !credential ||
      !expiresAt ||
      !verifiedEnvProof.ok ||
      verifiedEnvProof.claims.requestNonce !== nonce ||
      verifiedEnvProof.claims.clientProofKeyThumbprint !== auth.thumbprint
    ) {
      sendJson(res, 502, {
        code: "environment_endpoint_unavailable",
        reason: "endpoint_response_invalid",
      });
      return true;
    }
    sendJson(res, 200, {
      environmentId: env.environmentId,
      endpoint: {
        httpBaseUrl: env.httpBaseUrl,
        wsBaseUrl: env.wsBaseUrl,
        providerKind: env.providerKind,
      },
      credential,
      expiresAt,
    });
    return true;
  }

  const envStatusMatch = /^\/v1\/environments\/([^/]+)\/status$/u.exec(path);
  if (method === "POST" && envStatusMatch) {
    const auth = authenticateDpopClient({
      req,
      path,
      config,
      mintKeys,
      db,
      requiredScope: "environment:status",
    });
    if (!auth.ok) {
      sendJson(res, auth.status, auth.error);
      return true;
    }
    const environmentId = decodeURIComponent(envStatusMatch[1]!);
    const env = db.getEnvironment(environmentId, auth.userId);
    if (!env || env.revokedAt !== null) {
      sendJson(res, 403, {
        code: "environment_connect_not_authorized",
        reason: "link_revoked",
      });
      return true;
    }
    const endpoint = {
      httpBaseUrl: env.httpBaseUrl,
      wsBaseUrl: env.wsBaseUrl,
      providerKind: env.providerKind,
    };
    const checkedAt = new Date().toISOString();
    if (
      env.providerKind === "t3_relay" &&
      (!env.tunnelId || !tunnelHub.hasActiveTunnel(env.tunnelId))
    ) {
      sendJson(res, 200, {
        environmentId: env.environmentId,
        endpoint,
        status: "offline",
        checkedAt,
        error: "Environment tunnel is offline.",
        ...(env.connectorTokenHash === null ? { offlineReason: "tunnel_released" } : {}),
      });
      return true;
    }
    const nowSec = Math.floor(Date.now() / 1_000);
    const nonce = randomToken(16);
    const proof = signEdDsaJwt({
      privateKeyPem: mintKeys.privateKeyPem,
      typ: RELAY_HEALTH_REQUEST_TYP,
      kid: mintKeys.kid,
      payload: {
        iss: issuer,
        aud: `t3-env:${env.environmentId}`,
        sub: env.userId,
        jti: randomUuid(),
        iat: nowSec,
        exp: nowSec + 120,
        environmentId: env.environmentId,
        nonce,
        scope: ["environment:status"],
      },
    });
    const dispatched = await dispatchToEnvironment({
      tunnelHub,
      env,
      path: "/api/t3-connect/health",
      payload: { proof },
    });
    if (!dispatched.ok) {
      sendJson(res, 200, {
        environmentId: env.environmentId,
        endpoint,
        status: "offline",
        checkedAt,
        error: dispatched.message,
        ...(dispatched.status ? { endpointStatus: dispatched.status } : {}),
      });
      return true;
    }
    const envProof = typeof dispatched.json.proof === "string" ? dispatched.json.proof : "";
    const verifiedHealth = verifyEdDsaJwt({
      publicKeyPem: env.environmentPublicKey,
      token: envProof,
      expectedTyp: RELAY_HEALTH_RESPONSE_TYP,
      expectedIssuer: `t3-env:${env.environmentId}`,
      expectedAudience: issuer,
    });
    if (!verifiedHealth.ok || verifiedHealth.claims.requestNonce !== nonce) {
      sendJson(res, 200, {
        environmentId: env.environmentId,
        endpoint,
        status: "offline",
        checkedAt,
        error: "Invalid health proof returned by environment.",
      });
      return true;
    }
    sendJson(res, 200, {
      environmentId: env.environmentId,
      endpoint,
      status: "online",
      checkedAt,
      descriptor: dispatched.json.descriptor,
    });
    return true;
  }

  const tunnelRecoveryRegMatch = /^\/v1\/environments\/([^/]+)\/tunnel\/recovery$/u.exec(path);
  if (method === "POST" && tunnelRecoveryRegMatch) {
    const bearer = extractBearerToken(req);
    const environmentId = decodeURIComponent(tunnelRecoveryRegMatch[1]!);
    const env = bearer
      ? db.findActiveEnvironmentByCredential(environmentId, sha256Base64Url(bearer))
      : null;
    const payload = parseJsonBody(body);
    const proof = typeof payload?.proof === "string" ? payload.proof : "";
    const tunnelId = typeof payload?.tunnelId === "string" ? payload.tunnelId : "";
    if (!env || !proof) {
      sendJson(res, 401, { code: "auth_invalid", reason: "invalid_bearer" });
      return true;
    }
    const verified = verifyEdDsaJwt({
      publicKeyPem: env.environmentPublicKey,
      token: proof,
      expectedTyp: RELAY_MANAGED_TUNNEL_RECOVERY_TYP,
      expectedIssuer: `t3-env:${env.environmentId}`,
      expectedAudience: issuer,
    });
    if (
      !verified.ok ||
      verified.claims.action !== "register" ||
      verified.claims.cloudUserId !== env.userId
    ) {
      sendJson(res, 401, { code: "auth_invalid", reason: "invalid_proof" });
      return true;
    }
    const ready =
      env.providerKind === "t3_relay" &&
      env.tunnelId === tunnelId &&
      env.connectorTokenHash !== null;
    sendJson(res, 200, { status: ready ? "ready" : "recovery_required" });
    return true;
  }

  const tunnelRecoverMatch = /^\/v1\/environments\/([^/]+)\/tunnel$/u.exec(path);
  if (method === "POST" && tunnelRecoverMatch) {
    const bearer = extractBearerToken(req);
    const environmentId = decodeURIComponent(tunnelRecoverMatch[1]!);
    const env = bearer
      ? db.findActiveEnvironmentByCredential(environmentId, sha256Base64Url(bearer))
      : null;
    const payload = parseJsonBody(body);
    const proof = typeof payload?.proof === "string" ? payload.proof : "";
    if (!env || !proof || env.providerKind !== "t3_relay" || !env.tunnelId || !env.tunnelName) {
      sendJson(res, 401, { code: "auth_invalid", reason: "invalid_bearer" });
      return true;
    }
    const verified = verifyEdDsaJwt({
      publicKeyPem: env.environmentPublicKey,
      token: proof,
      expectedTyp: RELAY_MANAGED_TUNNEL_RECOVERY_TYP,
      expectedIssuer: `t3-env:${env.environmentId}`,
      expectedAudience: issuer,
    });
    if (
      !verified.ok ||
      verified.claims.action !== "recover" ||
      verified.claims.cloudUserId !== env.userId
    ) {
      sendJson(res, 401, { code: "auth_invalid", reason: "invalid_proof" });
      return true;
    }
    const connectorToken = `lct_${randomToken(32)}`;
    const endpointKey = sha256Hex(`${env.userId}:${env.environmentId}`).slice(0, 16);
    const nextTunnelSlug = env.tunnelSlug?.trim() || `env-${endpointKey}`;
    const nextTunnelName = env.tunnelName.endsWith(`-${endpointKey}`)
      ? env.tunnelName
      : `lunacode-${endpointKey}`;
    const urls = buildManagedTunnelUrls({ config, tunnelSlug: nextTunnelSlug });
    const nowIso = new Date().toISOString();
    db.db
      .prepare(
        `UPDATE environments
         SET tunnel_name = ?, tunnel_slug = ?, tunnel_host = ?, http_base_url = ?, ws_base_url = ?,
             connector_token_hash = ?, updated_at = ?
         WHERE environment_id = ? AND user_id = ?`,
      )
      .run(
        nextTunnelName,
        nextTunnelSlug,
        urls.tunnelHost,
        urls.httpBaseUrl,
        urls.wsBaseUrl,
        sha256Base64Url(connectorToken),
        nowIso,
        env.environmentId,
        env.userId,
      );
    tunnelHub.closeTunnel(env.tunnelId, "Tunnel token rotated");
    sendJson(res, 200, {
      endpoint: {
        httpBaseUrl: urls.httpBaseUrl,
        wsBaseUrl: urls.wsBaseUrl,
        providerKind: "t3_relay",
      },
      endpointRuntime: {
        providerKind: "t3_relay",
        connectorToken,
        tunnelId: env.tunnelId,
        tunnelName: nextTunnelName,
      },
    });
    return true;
  }

  const webhookMatch = /^\/v1\/hooks\/([^/]+)\/([^/]+)\/([^/]+)$/u.exec(path);
  if (
    webhookMatch &&
    (method === "POST" || method === "PUT" || method === "PATCH" || method === "GET")
  ) {
    const endpointKey = decodeURIComponent(webhookMatch[1]!);
    const hookId = decodeURIComponent(webhookMatch[2]!);
    const token = decodeURIComponent(webhookMatch[3]!);
    const env = db.findActiveEnvironmentByEndpointKey(endpointKey);
    if (!env) {
      sendJson(res, 404, { error: "hook_endpoint_not_found" });
      return true;
    }
    const owner = db.findUserById(env.userId);
    if (!owner || owner.disabledAt !== null || !owner.permissions.webhooks) {
      sendJson(res, 403, { error: "webhooks_disabled" });
      return true;
    }
    if (body.length > WEBHOOK_MAX_BODY_BYTES) {
      sendJson(res, 413, { error: "payload_too_large" });
      return true;
    }

    const cleanedHeaders = sanitizeWebhookForwardHeaders(req.headers);
    const deliveryId = randomUuid();
    const receivedAt = new Date().toISOString();
    const queryString = url.search ? url.search.slice(1) : "";

    if (env.tunnelId && tunnelHub.hasActiveTunnel(env.tunnelId)) {
      const delivered = await deliverWebhookToEnvironment({
        env,
        tunnelHub,
        mintKeys,
        issuer,
        deliveryId,
        receivedAt,
        hookId,
        token,
        method,
        queryString,
        headers: cleanedHeaders,
        body,
      });
      if (delivered.ok) {
        const resHeaders: Record<string, string | Array<string>> = {
          "cache-control": "no-store",
        };
        for (const headerName of ["content-type", "x-t3-hook-outcome", "retry-after"]) {
          const val = delivered.headers[headerName];
          if (val !== undefined) resHeaders[headerName] = val;
        }
        res.writeHead(delivered.status, resHeaders);
        res.end(delivered.body);
        return true;
      }
      if (delivered.failure !== "tunnel_down") {
        sendJson(res, 502, { error: delivered.error });
        return true;
      }
    }

    if (env.holdWebhooksWhileOffline === 1) {
      db.enqueueHeldWebhook({
        deliveryId,
        environmentId: env.environmentId,
        userId: env.userId,
        hookId,
        token,
        method,
        queryString,
        headers: cleanedHeaders,
        bodyBase64: body.toString("base64"),
        receivedAt,
        expiresAtMs: Date.now() + HELD_WEBHOOK_TTL_MS,
      });
      sendJson(res, 202, { status: "held", deliveryId });
      return true;
    }

    sendJson(res, 503, { error: "environment_offline" });
    return true;
  }

  const envPrefMatch =
    /^\/v1\/environments\/([^/]+)\/(link-preferences|live-activity-preference|hooks\/wake)$/u.exec(
      path,
    );
  if (method === "POST" && envPrefMatch) {
    const bearer = extractBearerToken(req);
    const environmentId = decodeURIComponent(envPrefMatch[1]!);
    const env = bearer
      ? db.findActiveEnvironmentByCredential(environmentId, sha256Base64Url(bearer))
      : null;
    if (!env) {
      sendJson(res, 401, { code: "auth_invalid", reason: "invalid_bearer" });
      return true;
    }
    const owner = db.findUserById(env.userId);
    if (!owner || owner.disabledAt !== null) {
      sendJson(res, 401, { code: "auth_invalid", reason: "account_disabled" });
      return true;
    }
    const action = envPrefMatch[2]!;
    const payload = parseJsonBody(body) ?? {};
    if (action === "link-preferences") {
      const hold = payload.holdWebhooksWhileOffline === true;
      if (hold && !owner.permissions.webhooks) {
        sendJson(res, 403, {
          code: "auth_invalid",
          reason: "not_authorized",
          traceId: randomUuid(),
        });
        return true;
      }
      db.updateLinkPreferences(env.environmentId, env.userId, hold);
      sendJson(res, 200, { holdWebhooksWhileOffline: hold });
      return true;
    }
    if (action === "live-activity-preference") {
      const ok = db.updateLiveActivityPreference(
        env.environmentId,
        env.userId,
        payload.liveActivitiesEnabled === true,
      );
      sendJson(res, 200, { ok });
      return true;
    }
    if (!owner.permissions.webhooks) {
      sendJson(res, 403, {
        code: "auth_invalid",
        reason: "not_authorized",
        traceId: randomUuid(),
      });
      return true;
    }
    const replay = await replayHeldWebhooksForEnvironment({
      env,
      db,
      tunnelHub,
      mintKeys,
      issuer,
    });
    sendJson(res, 200, { pending: replay.pending });
    return true;
  }

  const agentActivityMatch =
    /^\/v1\/environments\/([^/]+)\/threads\/([^/]+)\/agent-activity$/u.exec(path);
  if (method === "POST" && agentActivityMatch) {
    const bearer = extractBearerToken(req);
    const environmentId = decodeURIComponent(agentActivityMatch[1]!);
    const threadId = decodeURIComponent(agentActivityMatch[2]!);
    const env = bearer
      ? db.findActiveEnvironmentByCredential(environmentId, sha256Base64Url(bearer))
      : null;
    if (!env) {
      sendJson(res, 401, { code: "auth_invalid", reason: "invalid_bearer" });
      return true;
    }
    const owner = db.findUserById(env.userId);
    if (!owner || owner.disabledAt !== null) {
      sendJson(res, 401, { code: "auth_invalid", reason: "account_disabled" });
      return true;
    }
    const payload = parseJsonBody(body);
    const proof = typeof payload?.proof === "string" ? payload.proof : "";
    const verified = verifyEdDsaJwt({
      publicKeyPem: env.environmentPublicKey,
      token: proof,
      expectedTyp: RELAY_ACTIVITY_PROOF_TYP,
      expectedIssuer: `t3-env:${env.environmentId}`,
      expectedAudience: issuer,
    });
    const claimedState = verified.ok ? (verified.claims.state ?? null) : null;
    const bodyState = payload?.state ?? null;
    if (
      !verified.ok ||
      verified.claims.environmentId !== environmentId ||
      verified.claims.threadId !== threadId ||
      !sameJsonValue(claimedState, bodyState)
    ) {
      const reason =
        !verified.ok && (verified.reason === "expired" || verified.reason === "max_age_exceeded")
          ? "proof_expired"
          : "invalid_signature_or_payload";
      sendJson(res, 401, {
        code: "agent_activity_publish_proof_invalid",
        reason,
        traceId: randomUuid(),
      });
      return true;
    }

    const previous = db.getAgentActivity(env.userId, environmentId, threadId);
    let parsedState: {
      readonly environmentId: string;
      readonly threadId: string;
      readonly projectTitle: string;
      readonly threadTitle: string;
      readonly modelTitle: string;
      readonly phase: string;
      readonly headline: string;
      readonly detail?: string;
      readonly updatedAt: string;
      readonly deepLink: string;
    } | null = null;

    if (bodyState === null) {
      db.deleteAgentActivity(env.userId, environmentId, threadId);
    } else if (typeof bodyState === "object") {
      const s = bodyState as Record<string, unknown>;
      const updatedAt =
        typeof s.updatedAt === "string" && s.updatedAt.trim()
          ? s.updatedAt.trim()
          : new Date().toISOString();
      parsedState = {
        environmentId,
        threadId,
        projectTitle:
          typeof s.projectTitle === "string" && s.projectTitle.trim()
            ? s.projectTitle.trim()
            : env.label,
        threadTitle:
          typeof s.threadTitle === "string" && s.threadTitle.trim()
            ? s.threadTitle.trim()
            : threadId,
        modelTitle:
          typeof s.modelTitle === "string" && s.modelTitle.trim() ? s.modelTitle.trim() : "Agent",
        phase: typeof s.phase === "string" && s.phase.trim() ? s.phase.trim() : "running",
        headline:
          typeof s.headline === "string" && s.headline.trim() ? s.headline.trim() : "Working",
        ...(typeof s.detail === "string" && s.detail.trim() ? { detail: s.detail.trim() } : {}),
        updatedAt,
        deepLink:
          typeof s.deepLink === "string" && s.deepLink.trim()
            ? s.deepLink.trim()
            : `lunacode://threads/${environmentId}/${threadId}`,
      };
      db.upsertAgentActivity({
        userId: env.userId,
        environmentId,
        threadId,
        projectTitle: parsedState.projectTitle,
        threadTitle: parsedState.threadTitle,
        modelTitle: parsedState.modelTitle,
        phase: parsedState.phase,
        headline: parsedState.headline,
        detail: parsedState.detail ?? null,
        updatedAt: parsedState.updatedAt,
        deepLink: parsedState.deepLink,
        updatedAtMs: Date.parse(parsedState.updatedAt) || Date.now(),
      });
    }

    const aggregate = buildAgentActivityAggregate(db.listAgentActivitiesForUser(env.userId));
    const deliveries = await dispatchPushForActivity({
      config,
      db,
      userId: env.userId,
      previousPhase: previous?.phase ?? null,
      state: parsedState,
      aggregate,
    });
    sendJson(res, 200, { ok: true, deliveries });
    return true;
  }

  if (method === "POST" && path === "/v1/mobile/devices") {
    const auth = authenticateDpopClient({
      req,
      path,
      config,
      mintKeys,
      db,
      requiredScope: "mobile:registration",
    });
    if (!auth.ok) {
      sendJson(res, auth.status, auth.error);
      return true;
    }
    const user = db.findUserById(auth.userId);
    if (!user || !user.permissions.mobilePush) {
      sendJson(res, 403, {
        code: "auth_invalid",
        reason: "not_authorized",
        traceId: randomUuid(),
      });
      return true;
    }
    const payload = parseJsonBody(body) ?? {};
    const deviceId =
      typeof payload.deviceId === "string" && payload.deviceId ? payload.deviceId : randomUuid();
    db.upsertDevice(auth.userId, deviceId, {
      ...payload,
      deviceId,
      updatedAt: new Date().toISOString(),
    });
    sendJson(res, 200, { ok: true });
    return true;
  }

  const unregisterDeviceMatch = /^\/v1\/mobile\/devices\/([^/]+)$/u.exec(path);
  if (method === "DELETE" && unregisterDeviceMatch) {
    const auth = authenticateDpopClient({
      req,
      path,
      config,
      mintKeys,
      db,
      requiredScope: "mobile:registration",
    });
    if (!auth.ok) {
      sendJson(res, auth.status, auth.error);
      return true;
    }
    const deviceId = decodeURIComponent(unregisterDeviceMatch[1]!);
    db.deleteDevice(auth.userId, deviceId);
    db.deleteLiveActivityToken(auth.userId, deviceId);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (method === "POST" && path === "/v1/mobile/live-activities") {
    const auth = authenticateDpopClient({
      req,
      path,
      config,
      mintKeys,
      db,
      requiredScope: "mobile:registration",
    });
    if (!auth.ok) {
      sendJson(res, auth.status, auth.error);
      return true;
    }
    const user = db.findUserById(auth.userId);
    if (!user || !user.permissions.mobilePush) {
      sendJson(res, 403, {
        code: "auth_invalid",
        reason: "not_authorized",
        traceId: randomUuid(),
      });
      return true;
    }
    const payload = parseJsonBody(body);
    const deviceId = typeof payload?.deviceId === "string" ? payload.deviceId.trim() : "";
    const activityPushToken =
      typeof payload?.activityPushToken === "string" ? payload.activityPushToken.trim() : "";
    if (!deviceId || !activityPushToken) {
      sendJson(res, 400, { code: "invalid_request", reason: "missing_activity_token" });
      return true;
    }
    db.upsertLiveActivityToken(auth.userId, deviceId, activityPushToken);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (method === "GET" && path === "/v1/mobile/agent-activity") {
    const auth = authenticateDpopClient({
      req,
      path,
      config,
      mintKeys,
      db,
      requiredScope: "mobile:registration",
    });
    if (!auth.ok) {
      sendJson(res, auth.status, auth.error);
      return true;
    }
    const aggregate = buildAgentActivityAggregate(db.listAgentActivitiesForUser(auth.userId));
    sendJson(res, 200, { aggregate });
    return true;
  }

  return false;
}
