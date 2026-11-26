import * as NodeFS from "node:fs";
import type * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import type { ConnectConfig } from "./config.ts";
import {
  hashPassword,
  type MintKeyPair,
  nowEpochSeconds,
  randomToken,
  randomUuid,
  sha256Base64Url,
  signEdDsaJwt,
  verifyEdDsaJwt,
  verifyPassword,
  verifyPkceS256,
} from "./crypto.ts";
import {
  type ConnectDatabase,
  DEFAULT_USER_PERMISSIONS,
  type UserRole,
  type UserRow,
} from "./db.ts";

function serializeAuthUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    maxTunnels: user.maxTunnels,
    permissions: user.permissions,
  };
}

function hasHostedWebIndex(config: ConnectConfig): boolean {
  return Boolean(
    config.webDistDir && NodeFS.existsSync(NodePath.join(config.webDistDir, "index.html")),
  );
}

export interface HttpContext {
  readonly req: NodeHttp.IncomingMessage;
  readonly res: NodeHttp.ServerResponse;
  readonly url: URL;
  readonly body: Buffer;
}

export const SESSION_COOKIE_NAME = "lunacode_session";

export function sendJson(
  res: NodeHttp.ServerResponse,
  statusCode: number,
  body: unknown,
  extraHeaders?: Record<string, string | Array<string>>,
): void {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(json);
}

export function sendHtml(
  res: NodeHttp.ServerResponse,
  statusCode: number,
  html: string,
  extraHeaders?: Record<string, string | Array<string>>,
): void {
  res.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(html);
}

export function parseJsonBody(body: Buffer): Record<string, unknown> | null {
  if (body.length === 0) return {};
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function parseFormOrJsonBody(
  req: NodeHttp.IncomingMessage,
  body: Buffer,
): Record<string, string> {
  const ct = String(req.headers["content-type"] ?? "").toLowerCase();
  if (ct.includes("application/json")) {
    const parsed = parseJsonBody(body) ?? {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value;
      else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
    }
    return out;
  }
  const params = new URLSearchParams(body.toString("utf8"));
  const out: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    out[key] = value;
  }
  return out;
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const chunk of cookieHeader.split(";")) {
    const eq = chunk.indexOf("=");
    if (eq <= 0) continue;
    const key = chunk.slice(0, eq).trim();
    const val = chunk.slice(eq + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

export function extractBearerToken(req: NodeHttp.IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth !== "string") return null;
  const match = /^Bearer\s+(.+)$/iu.exec(auth.trim());
  return match?.[1]?.trim() || null;
}

export function issueUserTokens(input: {
  readonly config: ConnectConfig;
  readonly mintKeys: MintKeyPair;
  readonly db: ConnectDatabase;
  readonly user: UserRow;
  readonly clientId: string;
  readonly scope: string;
  readonly issueRefreshToken: boolean;
}) {
  const nowSec = nowEpochSeconds();
  const accessExp = nowSec + input.config.accessTokenTtlSeconds;
  const payload = {
    iss: input.config.publicOrigin,
    aud: input.config.publicOrigin,
    sub: input.user.id,
    email: input.user.email,
    name: input.user.displayName,
    preferred_username: input.user.email,
    jti: randomUuid(),
    iat: nowSec,
    exp: accessExp,
  };
  const accessToken = signEdDsaJwt({
    privateKeyPem: input.mintKeys.privateKeyPem,
    typ: "JWT",
    kid: input.mintKeys.kid,
    payload,
  });
  const idToken = signEdDsaJwt({
    privateKeyPem: input.mintKeys.privateKeyPem,
    typ: "JWT",
    kid: input.mintKeys.kid,
    payload: {
      ...payload,
      aud: input.clientId,
    },
  });
  let refreshToken: string | undefined;
  if (input.issueRefreshToken) {
    refreshToken = `rt_${randomToken(32)}`;
    input.db.createRefreshToken({
      tokenHash: sha256Base64Url(refreshToken),
      userId: input.user.id,
      clientId: input.clientId,
      scope: input.scope,
      expiresAt: nowSec + input.config.refreshTokenTtlSeconds,
      revokedAt: null,
    });
  }
  return {
    accessToken,
    idToken,
    refreshToken,
    expiresIn: input.config.accessTokenTtlSeconds,
    expiresAt: new Date(accessExp * 1_000).toISOString(),
  };
}

export async function bootstrapAdmins(input: {
  readonly config: ConnectConfig;
  readonly db: ConnectDatabase;
}): Promise<void> {
  const { config, db } = input;
  if (config.adminEmail && config.adminPassword && config.adminPassword.length >= 8) {
    if (!db.findUserByEmail(config.adminEmail)) {
      const user: UserRow = {
        id: `usr_${randomUuid().replace(/-/g, "")}`,
        email: config.adminEmail,
        passwordHash: await hashPassword(config.adminPassword),
        displayName: config.adminEmail.split("@")[0] || "Admin",
        role: "admin",
        maxTunnels: 100,
        permissions: DEFAULT_USER_PERMISSIONS,
        disabledAt: null,
        createdAt: new Date().toISOString(),
      };
      db.createUser(user);
    }
  }

  const promoteSet = new Set(config.adminEmails);
  if (config.adminEmail) {
    promoteSet.add(config.adminEmail);
  }
  if (promoteSet.size > 0) {
    db.promoteEmailsToAdmin(promoteSet);
  }

  if (db.countUsers() > 0 && db.countActiveAdmins() === 0) {
    db.promoteEarliestUserToAdmin();
  }
}

function authenticateSessionOrBearerDetailed(input: {
  readonly req: NodeHttp.IncomingMessage;
  readonly config: ConnectConfig;
  readonly mintKeys: MintKeyPair;
  readonly db: ConnectDatabase;
}): { readonly user: UserRow; readonly sessionTokenHash: string | null } | null {
  const bearer = extractBearerToken(input.req);
  if (bearer) {
    const verified = verifyEdDsaJwt({
      publicKeyPem: input.mintKeys.publicKeyPem,
      token: bearer,
      expectedTyp: "JWT",
      expectedIssuer: input.config.publicOrigin,
      expectedAudience: input.config.publicOrigin,
    });
    if (!verified.ok || typeof verified.claims.sub !== "string") {
      return null;
    }
    const user = input.db.findUserById(verified.claims.sub);
    return user && user.disabledAt === null ? { user, sessionTokenHash: null } : null;
  }

  const cookies = parseCookies(input.req.headers.cookie);
  const rawSession = cookies[SESSION_COOKIE_NAME];
  if (!rawSession) return null;
  const tokenHash = sha256Base64Url(rawSession);
  const session = input.db.findValidSession(tokenHash, nowEpochSeconds());
  return session && session.user.disabledAt === null
    ? { user: session.user, sessionTokenHash: tokenHash }
    : null;
}

export function authenticateUserBearerOrSession(input: {
  readonly req: NodeHttp.IncomingMessage;
  readonly config: ConnectConfig;
  readonly mintKeys: MintKeyPair;
  readonly db: ConnectDatabase;
}): UserRow | null {
  return authenticateSessionOrBearerDetailed(input)?.user ?? null;
}

function buildSessionCookieHeader(
  config: ConnectConfig,
  rawToken: string,
  maxAgeSeconds: number,
): string {
  const isHttps = config.publicOrigin.startsWith("https://");
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isHttps) parts.push("Secure");
  return parts.join("; ");
}

function createSessionCookieForUser(
  config: ConnectConfig,
  db: ConnectDatabase,
  userId: string,
): string {
  const rawToken = `ses_${randomToken(32)}`;
  const nowSec = nowEpochSeconds();
  db.createSession({
    tokenHash: sha256Base64Url(rawToken),
    userId,
    expiresAt: nowSec + config.sessionTtlSeconds,
    createdAt: new Date().toISOString(),
  });
  return buildSessionCookieHeader(config, rawToken, config.sessionTtlSeconds);
}

export async function handleAuthRoute(input: {
  readonly ctx: HttpContext;
  readonly config: ConnectConfig;
  readonly mintKeys: MintKeyPair;
  readonly db: ConnectDatabase;
}): Promise<boolean> {
  const { ctx, config, mintKeys, db } = input;
  const { req, res, url, body } = ctx;
  const method = req.method ?? "GET";
  const path = url.pathname;

  if (method === "GET" && (path === "/.well-known/jwks.json" || path === "/api/auth/jwks")) {
    sendJson(res, 200, { keys: [mintKeys.publicJwk] });
    return true;
  }

  if (method === "POST" && path === "/api/auth/register") {
    if (!db.resolveAllowRegistration(config.allowRegistration)) {
      sendJson(res, 403, {
        error: "registration_disabled",
        message: "Account registration is disabled.",
      });
      return true;
    }
    const payload = parseJsonBody(body);
    const email = typeof payload?.email === "string" ? payload.email.trim().toLowerCase() : "";
    const password = typeof payload?.password === "string" ? payload.password : "";
    const displayNameRaw =
      typeof payload?.displayName === "string" ? payload.displayName.trim() : "";
    if (!email || !email.includes("@")) {
      sendJson(res, 400, { error: "invalid_email", message: "A valid email address is required." });
      return true;
    }
    const allowedEmails = db.resolveAllowedEmails(config.allowedEmails);
    if (allowedEmails.size > 0 && !allowedEmails.has(email)) {
      sendJson(res, 403, {
        error: "email_not_allowed",
        message: "This email is not permitted to register.",
      });
      return true;
    }
    if (password.length < 8) {
      sendJson(res, 400, {
        error: "weak_password",
        message: "Password must be at least 8 characters.",
      });
      return true;
    }
    if (db.findUserByEmail(email)) {
      sendJson(res, 409, {
        error: "email_exists",
        message: "An account with this email already exists.",
      });
      return true;
    }
    const role: UserRole =
      db.countUsers() === 0 || config.adminEmails.has(email) || config.adminEmail === email
        ? "admin"
        : "user";
    const user: UserRow = {
      id: `usr_${randomUuid().replace(/-/g, "")}`,
      email,
      passwordHash: await hashPassword(password),
      displayName: displayNameRaw || email.split("@")[0] || email,
      role,
      maxTunnels: role === "admin" ? 100 : config.defaultUserMaxTunnels,
      permissions: DEFAULT_USER_PERMISSIONS,
      disabledAt: null,
      createdAt: new Date().toISOString(),
    };
    db.createUser(user);
    const cookie = createSessionCookieForUser(config, db, user.id);
    const tokens = issueUserTokens({
      config,
      mintKeys,
      db,
      user,
      clientId: "lunacode-app",
      scope: "openid profile email offline_access",
      issueRefreshToken: true,
    });
    sendJson(
      res,
      201,
      {
        user: serializeAuthUser(user),
        ...tokens,
      },
      { "set-cookie": cookie },
    );
    return true;
  }

  if (method === "POST" && path === "/api/auth/login") {
    const payload = parseJsonBody(body);
    const email = typeof payload?.email === "string" ? payload.email.trim().toLowerCase() : "";
    const password = typeof payload?.password === "string" ? payload.password : "";
    const user = email ? db.findUserByEmail(email) : null;
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      sendJson(res, 401, { error: "invalid_credentials", message: "Invalid email or password." });
      return true;
    }
    if (user.disabledAt !== null) {
      sendJson(res, 403, { error: "account_disabled", message: "该账号已被管理员禁用。" });
      return true;
    }
    const cookie = createSessionCookieForUser(config, db, user.id);
    const tokens = issueUserTokens({
      config,
      mintKeys,
      db,
      user,
      clientId: "lunacode-app",
      scope: "openid profile email offline_access",
      issueRefreshToken: true,
    });
    sendJson(
      res,
      200,
      {
        user: serializeAuthUser(user),
        ...tokens,
      },
      { "set-cookie": cookie },
    );
    return true;
  }

  if (method === "POST" && path === "/api/auth/logout") {
    const cookies = parseCookies(req.headers.cookie);
    const rawSession = cookies[SESSION_COOKIE_NAME];
    if (rawSession) {
      db.deleteSession(sha256Base64Url(rawSession));
    }
    const payload = parseJsonBody(body);
    if (typeof payload?.refreshToken === "string" && payload.refreshToken.trim()) {
      db.revokeRefreshToken(sha256Base64Url(payload.refreshToken.trim()));
    }
    sendJson(res, 200, { ok: true }, { "set-cookie": buildSessionCookieHeader(config, "", 0) });
    return true;
  }

  if (method === "GET" && path === "/api/auth/session") {
    const user = authenticateUserBearerOrSession({ req, config, mintKeys, db });
    if (!user) {
      sendJson(res, 401, { error: "unauthenticated" });
      return true;
    }
    const tokens = issueUserTokens({
      config,
      mintKeys,
      db,
      user,
      clientId: "lunacode-app",
      scope: "openid profile email",
      issueRefreshToken: false,
    });
    sendJson(res, 200, {
      user: serializeAuthUser(user),
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      expiresIn: tokens.expiresIn,
    });
    return true;
  }

  if (method === "GET" && path === "/api/auth/account") {
    const user = authenticateUserBearerOrSession({ req, config, mintKeys, db });
    if (!user) {
      sendJson(res, 401, { error: "unauthenticated" });
      return true;
    }
    sendJson(res, 200, {
      user: serializeAuthUser(user),
      activeTunnels: db.countActiveManagedTunnelsForUser(user.id),
      deviceCount: db.listDevicesForUser(user.id).length,
      activeSessionCount: db.countActiveSessionsForUser(user.id),
    });
    return true;
  }

  if (method === "PATCH" && path === "/api/auth/profile") {
    const user = authenticateUserBearerOrSession({ req, config, mintKeys, db });
    if (!user) {
      sendJson(res, 401, { error: "unauthenticated" });
      return true;
    }
    const payload = parseJsonBody(body);
    const displayName = typeof payload?.displayName === "string" ? payload.displayName.trim() : "";
    if (!displayName || displayName.length > 64) {
      sendJson(res, 400, {
        error: "invalid_request",
        message: "昵称不能为空且不超过 64 个字符。",
      });
      return true;
    }
    db.updateUserDisplayName(user.id, displayName);
    const updated = db.findUserById(user.id) ?? user;
    sendJson(res, 200, { ok: true, user: serializeAuthUser(updated) });
    return true;
  }

  if (method === "POST" && path === "/api/auth/change-password") {
    const auth = authenticateSessionOrBearerDetailed({ req, config, mintKeys, db });
    if (!auth) {
      sendJson(res, 401, { error: "unauthenticated" });
      return true;
    }
    const payload = parseJsonBody(body);
    const currentPassword =
      typeof payload?.currentPassword === "string" ? payload.currentPassword : "";
    const newPassword = typeof payload?.newPassword === "string" ? payload.newPassword : "";
    if (!(await verifyPassword(currentPassword, auth.user.passwordHash))) {
      sendJson(res, 401, { error: "invalid_credentials", message: "当前密码不正确。" });
      return true;
    }
    if (newPassword.length < 8) {
      sendJson(res, 400, { error: "weak_password", message: "新密码长度至少 8 位。" });
      return true;
    }
    const nextHash = await hashPassword(newPassword);
    db.updateUserPassword(auth.user.id, nextHash);
    db.revokeOtherSessionsForUser(auth.user.id, auth.sessionTokenHash);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (method === "POST" && path === "/api/auth/revoke-other-sessions") {
    const auth = authenticateSessionOrBearerDetailed({ req, config, mintKeys, db });
    if (!auth) {
      sendJson(res, 401, { error: "unauthenticated" });
      return true;
    }
    db.revokeOtherSessionsForUser(auth.user.id, auth.sessionTokenHash);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (method === "POST" && path === "/api/auth/token") {
    const payload = parseJsonBody(body);
    const rawRefresh = typeof payload?.refreshToken === "string" ? payload.refreshToken.trim() : "";
    if (rawRefresh) {
      const nowSec = nowEpochSeconds();
      const consumed = db.consumeRefreshToken(sha256Base64Url(rawRefresh), nowSec);
      if (!consumed) {
        sendJson(res, 401, {
          error: "invalid_grant",
          message: "Refresh token expired or revoked.",
        });
        return true;
      }
      const user = db.findUserById(consumed.userId);
      if (!user || user.disabledAt !== null) {
        sendJson(res, 401, { error: "invalid_grant" });
        return true;
      }
      const tokens = issueUserTokens({
        config,
        mintKeys,
        db,
        user,
        clientId: consumed.clientId,
        scope: consumed.scope,
        issueRefreshToken: true,
      });
      sendJson(res, 200, {
        user: serializeAuthUser(user),
        ...tokens,
      });
      return true;
    }
    const sessionUser = authenticateUserBearerOrSession({ req, config, mintKeys, db });
    if (!sessionUser) {
      sendJson(res, 401, { error: "unauthenticated" });
      return true;
    }
    const tokens = issueUserTokens({
      config,
      mintKeys,
      db,
      user: sessionUser,
      clientId: "lunacode-app",
      scope: "openid profile email",
      issueRefreshToken: false,
    });
    sendJson(res, 200, {
      user: serializeAuthUser(sessionUser),
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      expiresIn: tokens.expiresIn,
    });
    return true;
  }

  if (method === "POST" && path === "/api/auth/cli/authorize") {
    const user = authenticateUserBearerOrSession({ req, config, mintKeys, db });
    if (!user) {
      sendJson(res, 401, { error: "unauthenticated" });
      return true;
    }
    const payload = parseJsonBody(body);
    const state = typeof payload?.state === "string" ? payload.state.trim() : "";
    const challenge = typeof payload?.challenge === "string" ? payload.challenge.trim() : "";
    const loopbackPort =
      typeof payload?.loopbackPort === "number"
        ? payload.loopbackPort
        : Number(payload?.loopbackPort);
    const explicitRedirect =
      typeof payload?.redirectUri === "string" ? payload.redirectUri.trim() : "";
    const clientId =
      typeof payload?.clientId === "string" && payload.clientId.trim()
        ? payload.clientId.trim()
        : "lunacode-cli";
    const scope =
      typeof payload?.scope === "string" && payload.scope.trim()
        ? payload.scope.trim()
        : "openid profile email offline_access";

    let redirectUri = explicitRedirect;
    if (
      !redirectUri &&
      Number.isInteger(loopbackPort) &&
      loopbackPort >= 1 &&
      loopbackPort <= 65535
    ) {
      redirectUri = `http://127.0.0.1:${loopbackPort}/callback`;
    }
    if (!state || !challenge || !isSafeLoopbackRedirect(redirectUri)) {
      sendJson(res, 400, {
        error: "invalid_request",
        message: "Invalid CLI authorization parameters.",
      });
      return true;
    }
    const rawCode = `ac_${randomToken(24)}`;
    db.createOAuthCode({
      codeHash: sha256Base64Url(rawCode),
      userId: user.id,
      clientId,
      redirectUri,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scope,
      expiresAt: nowEpochSeconds() + 300,
      usedAt: null,
    });
    const callbackUrl = new URL(redirectUri);
    callbackUrl.searchParams.set("code", rawCode);
    callbackUrl.searchParams.set("state", state);
    sendJson(res, 200, { redirectTo: callbackUrl.toString() });
    return true;
  }

  if (method === "POST" && path === "/oauth/device/code") {
    const form = parseFormOrJsonBody(req, body);
    const clientId = form.client_id || "lunacode-cli";
    const scope = form.scope || "openid profile email offline_access";
    const deviceCode = `dc_${randomToken(32)}`;
    const userCode = generateUserCode();
    const expiresIn = 600;
    const interval = 5;
    db.createDeviceCode({
      deviceCodeHash: sha256Base64Url(deviceCode),
      userCode,
      clientId,
      scope,
      expiresAt: nowEpochSeconds() + expiresIn,
      intervalSec: interval,
    });
    const verificationUri = `${config.publicOrigin}/oauth/device`;
    const verificationUriComplete = `${verificationUri}?user_code=${encodeURIComponent(userCode)}`;
    sendJson(res, 200, {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: verificationUri,
      verification_uri_complete: verificationUriComplete,
      expires_in: expiresIn,
      interval,
    });
    return true;
  }

  if (method === "POST" && path === "/oauth/device/approve") {
    const user = authenticateUserBearerOrSession({ req, config, mintKeys, db });
    if (!user) {
      sendJson(res, 401, { error: "unauthenticated" });
      return true;
    }
    const payload = parseJsonBody(body);
    const userCode =
      typeof payload?.userCode === "string" ? payload.userCode.trim().toUpperCase() : "";
    const deny = payload?.deny === true;
    if (!userCode) {
      sendJson(res, 400, { error: "invalid_request", message: "Device code is required." });
      return true;
    }
    const ok = db.approveDeviceCode(userCode, user.id, deny, nowEpochSeconds());
    if (!ok) {
      sendJson(res, 404, {
        error: "invalid_or_expired_code",
        message: "Device code is invalid or expired.",
      });
      return true;
    }
    sendJson(res, 200, { ok: true, denied: deny });
    return true;
  }

  if (method === "POST" && path === "/oauth/token") {
    const form = parseFormOrJsonBody(req, body);
    const grantType = form.grant_type ?? "";
    const nowSec = nowEpochSeconds();

    if (grantType === "authorization_code") {
      const code = form.code ?? "";
      const redirectUri = form.redirect_uri ?? "";
      const codeVerifier = form.code_verifier ?? "";
      const consumed = code ? db.consumeOAuthCode(sha256Base64Url(code), nowSec) : null;
      if (
        !consumed ||
        consumed.redirectUri !== redirectUri ||
        !codeVerifier ||
        !verifyPkceS256(codeVerifier, consumed.codeChallenge)
      ) {
        sendJson(res, 400, {
          error: "invalid_grant",
          error_description: "Invalid or expired authorization code.",
        });
        return true;
      }
      const user = db.findUserById(consumed.userId);
      if (!user || user.disabledAt !== null) {
        sendJson(res, 400, { error: "invalid_grant" });
        return true;
      }
      const tokens = issueUserTokens({
        config,
        mintKeys,
        db,
        user,
        clientId: consumed.clientId,
        scope: consumed.scope,
        issueRefreshToken: true,
      });
      sendJson(res, 200, {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        id_token: tokens.idToken,
        token_type: "Bearer",
        expires_in: tokens.expiresIn,
      });
      return true;
    }

    if (grantType === "refresh_token") {
      const rawRefresh = form.refresh_token ?? "";
      const consumed = rawRefresh
        ? db.consumeRefreshToken(sha256Base64Url(rawRefresh), nowSec)
        : null;
      if (!consumed) {
        sendJson(res, 400, {
          error: "invalid_grant",
          error_description: "Invalid or expired refresh token.",
        });
        return true;
      }
      const user = db.findUserById(consumed.userId);
      if (!user || user.disabledAt !== null) {
        sendJson(res, 400, { error: "invalid_grant" });
        return true;
      }
      const tokens = issueUserTokens({
        config,
        mintKeys,
        db,
        user,
        clientId: consumed.clientId,
        scope: consumed.scope,
        issueRefreshToken: true,
      });
      sendJson(res, 200, {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        id_token: tokens.idToken,
        token_type: "Bearer",
        expires_in: tokens.expiresIn,
      });
      return true;
    }

    if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
      const deviceCode = form.device_code ?? "";
      const hash = sha256Base64Url(deviceCode);
      const row = deviceCode ? db.findDeviceCodeByHash(hash) : null;
      if (!row) {
        sendJson(res, 400, { error: "invalid_grant", error_description: "Unknown device code." });
        return true;
      }
      if (row.expiresAt <= nowSec) {
        db.deleteDeviceCode(hash);
        sendJson(res, 400, { error: "expired_token", error_description: "Device code expired." });
        return true;
      }
      if (row.denied === 1) {
        db.deleteDeviceCode(hash);
        sendJson(res, 400, { error: "access_denied", error_description: "Authorization denied." });
        return true;
      }
      if (!row.approvedAt || !row.userId) {
        sendJson(res, 400, { error: "authorization_pending" });
        return true;
      }
      const user = db.findUserById(row.userId);
      db.deleteDeviceCode(hash);
      if (!user || user.disabledAt !== null) {
        sendJson(res, 400, { error: "invalid_grant" });
        return true;
      }
      const tokens = issueUserTokens({
        config,
        mintKeys,
        db,
        user,
        clientId: row.clientId,
        scope: row.scope,
        issueRefreshToken: true,
      });
      sendJson(res, 200, {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        id_token: tokens.idToken,
        token_type: "Bearer",
        expires_in: tokens.expiresIn,
      });
      return true;
    }

    sendJson(res, 400, { error: "unsupported_grant_type" });
    return true;
  }

  const hostedWebEnabled = hasHostedWebIndex(config);
  if (method === "GET" && path === "/" && !hostedWebEnabled) {
    res.writeHead(302, {
      location: "/login",
      "cache-control": "no-store",
    });
    res.end();
    return true;
  }

  if (
    method === "GET" &&
    (path === "/connect" ||
      path === "/login" ||
      path === "/oauth/authorize" ||
      path === "/oauth/device")
  ) {
    const user = authenticateUserBearerOrSession({ req, config, mintKeys, db });
    sendHtml(
      res,
      200,
      renderConnectPortalHtml({
        mode: path === "/oauth/device" ? "device" : "connect",
        allowRegistration: db.resolveAllowRegistration(config.allowRegistration),
        hostedWebEnabled,
        initialUser: user ? serializeAuthUser(user) : null,
        initialUserCode: url.searchParams.get("user_code") ?? "",
      }),
    );
    return true;
  }

  return false;
}

function isSafeLoopbackRedirect(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function generateUserCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    if (i === 4) out += "-";
    const idx = Math.floor(Math.random() * alphabet.length);
    out += alphabet[idx]!;
  }
  return out;
}

function renderConnectPortalHtml(input: {
  readonly mode: "connect" | "device";
  readonly allowRegistration: boolean;
  readonly hostedWebEnabled: boolean;
  readonly initialUser: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
    readonly role: UserRole;
    readonly maxTunnels: number;
    readonly permissions: {
      readonly managedTunnels: boolean;
      readonly webhooks: boolean;
      readonly mobilePush: boolean;
    };
  } | null;
  readonly initialUserCode: string;
}): string {
  const initialStateJson = JSON.stringify(input).replace(/</gu, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>LunaCode Connect</title>
  <style>
    :root { color-scheme: dark; --bg:#0d1117; --card:#161b22; --border:#30363d; --fg:#f0f6fc; --muted:#8b949e; --accent:#58a6ff; --danger:#f85149; --ok:#3fb950; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:var(--bg); color:var(--fg); min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; }
    .card { width:100%; max-width:480px; background:var(--card); border:1px solid var(--border); border-radius:14px; padding:24px; box-shadow:0 16px 40px rgba(0,0,0,0.45); }
    h1 { margin:0 0 6px; font-size:20px; }
    p { margin:0 0 16px; color:var(--muted); font-size:13px; line-height:1.5; }
    .tabs { display:flex; gap:8px; margin-bottom:16px; }
    .tab { flex:1; padding:8px; border-radius:8px; border:1px solid var(--border); background:transparent; color:var(--muted); cursor:pointer; font-size:13px; }
    .tab.active { background:#1f6feb22; color:var(--fg); border-color:var(--accent); }
    label { display:block; font-size:12px; color:var(--muted); margin-bottom:6px; }
    input { width:100%; padding:10px 12px; border-radius:8px; border:1px solid var(--border); background:#0d1117; color:var(--fg); font-size:14px; margin-bottom:12px; }
    button.primary { width:100%; padding:10px 14px; border-radius:8px; border:none; background:#1f6feb; color:#fff; font-weight:600; font-size:14px; cursor:pointer; margin-top:4px; }
    button.secondary { width:100%; padding:9px 14px; border-radius:8px; border:1px solid var(--border); background:transparent; color:var(--fg); font-size:13px; cursor:pointer; margin-top:8px; }
    button.danger { width:100%; padding:9px 14px; border-radius:8px; border:1px solid #f8514966; background:transparent; color:var(--danger); font-size:13px; cursor:pointer; margin-top:8px; }
    .badge { display:inline-block; margin-left:6px; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; background:#1f6feb26; color:var(--accent); border:1px solid #388bfd55; vertical-align:middle; }
    .perm-row { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:14px; }
    .perm-pill { font-size:11px; padding:3px 9px; border-radius:999px; border:1px solid var(--border); }
    .perm-pill.on { border-color:#3fb95066; color:var(--ok); background:#2ea04322; }
    .perm-pill.off { border-color:#f8514955; color:var(--danger); background:#f8514915; }
    .quota-box { background:#0d1117; border:1px solid var(--border); border-radius:10px; padding:12px 14px; margin-bottom:14px; font-size:13px; }
    .section { border-top:1px solid var(--border); padding-top:14px; margin-top:14px; }
    .section h3 { margin:0 0 10px; font-size:13px; color:var(--muted); font-weight:600; }
    .msg { font-size:13px; margin-top:12px; min-height:18px; }
    .msg.err { color:var(--danger); }
    .msg.ok { color:var(--ok); }
  </style>
</head>
<body>
  <div class="card">
    <h1>LunaCode Connect</h1>
    <p id="subtitle">自建账号与远程访问授权中心</p>
    <div id="root"></div>
    <div id="message" class="msg"></div>
  </div>
  <script>
    const STATE = ${initialStateJson};
    const root = document.getElementById("root");
    const msgEl = document.getElementById("message");
    let currentUser = STATE.initialUser;
    let authMode = "login";

    function escHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function showMsg(text, isErr) {
      msgEl.textContent = text || "";
      msgEl.className = "msg " + (text ? (isErr ? "err" : "ok") : "");
    }

    function readSafeNextPath() {
      const raw = new URLSearchParams(window.location.search).get("next");
      if (!raw) return null;
      return raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\\\") ? raw : null;
    }

    function readCliParams() {
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const query = new URLSearchParams(window.location.search);
      const state = hash.get("state") || query.get("state");
      const challenge = hash.get("challenge") || query.get("code_challenge");
      const port = hash.get("port");
      const redirectUri = query.get("redirect_uri");
      if (state && challenge && (port || redirectUri)) {
        return { state, challenge, loopbackPort: port ? Number(port) : undefined, redirectUri };
      }
      return null;
    }

    async function authorizeCliIfPending() {
      const cli = readCliParams();
      if (!cli) return false;
      showMsg("正在完成 CLI 授权并跳转回本地端口...", false);
      const res = await fetch("/api/auth/cli/authorize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cli),
      });
      const data = await res.json();
      if (!res.ok) {
        showMsg(data.message || data.error || "授权失败", true);
        return true;
      }
      window.location.href = data.redirectTo;
      return true;
    }

    async function render() {
      if (!currentUser) {
        root.innerHTML = (STATE.allowRegistration ? \`
          <div class="tabs">
            <button class="tab \${authMode === "login" ? "active" : ""}" id="tabLogin">登录</button>
            <button class="tab \${authMode === "register" ? "active" : ""}" id="tabReg">注册</button>
          </div>\` : "") + \`
          <form id="authForm">
            \${authMode === "register" ? '<label>昵称</label><input id="displayName" placeholder="你的称呼" />' : ""}
            <label>邮箱</label>
            <input id="email" type="email" required placeholder="you@example.com" />
            <label>密码</label>
            <input id="password" type="password" required minlength="8" placeholder="至少 8 位" />
            <button class="primary" type="submit">\${authMode === "register" ? "创建账号并继续" : "登录并继续"}</button>
          </form>\`;
        if (STATE.allowRegistration) {
          document.getElementById("tabLogin").onclick = () => { authMode = "login"; showMsg(""); render(); };
          document.getElementById("tabReg").onclick = () => { authMode = "register"; showMsg(""); render(); };
        }
        document.getElementById("authForm").onsubmit = async (e) => {
          e.preventDefault();
          showMsg("");
          const body = {
            email: document.getElementById("email").value,
            password: document.getElementById("password").value,
          };
          if (authMode === "register") body.displayName = document.getElementById("displayName").value;
          const res = await fetch(authMode === "register" ? "/api/auth/register" : "/api/auth/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await res.json();
          if (!res.ok) {
            showMsg(data.message || data.error || "操作失败", true);
            return;
          }
          currentUser = data.user;
          if (!readCliParams()) {
            const nextPath = readSafeNextPath();
            if (nextPath) {
              window.location.href = nextPath;
              return;
            }
          }
          await render();
        };
        return;
      }

      if (STATE.mode === "device") {
        root.innerHTML = \`
          <p>当前登录：<strong>\${escHtml(currentUser.email)}</strong></p>
          <form id="deviceForm">
            <label>设备确认码</label>
            <input id="userCode" value="\${escHtml(STATE.initialUserCode || "")}" placeholder="ABCD-EFGH" required />
            <button class="primary" type="submit">确认授权该设备</button>
          </form>
          <button class="secondary" id="logoutBtn">切换账号</button>\`;
        document.getElementById("deviceForm").onsubmit = async (e) => {
          e.preventDefault();
          const res = await fetch("/oauth/device/approve", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ userCode: document.getElementById("userCode").value }),
          });
          const data = await res.json();
          if (!res.ok) showMsg(data.message || data.error || "授权失败", true);
          else showMsg("设备已授权，请返回终端查看。", false);
        };
        document.getElementById("logoutBtn").onclick = async () => {
          await fetch("/api/auth/logout", { method: "POST" });
          currentUser = null;
          await render();
        };
        return;
      }

      const cli = readCliParams();
      if (cli) {
        await authorizeCliIfPending();
        return;
      }

      let accountInfo = null;
      try {
        const accRes = await fetch("/api/auth/account");
        if (accRes.ok) {
          accountInfo = await accRes.json();
          if (accountInfo?.user) currentUser = accountInfo.user;
        }
      } catch {}

      const isAdmin = currentUser.role === "admin";
      const perms = currentUser.permissions || { managedTunnels: true, webhooks: true, mobilePush: true };
      const activeTunnels = accountInfo?.activeTunnels ?? 0;
      const maxTunnels = currentUser.maxTunnels ?? 3;
      const activeSessions = accountInfo?.activeSessionCount ?? 1;

      root.innerHTML = \`
        <p>已登录为 <strong>\${escHtml(currentUser.email)}</strong>\${isAdmin ? '<span class="badge">超级管理员</span>' : '<span class="badge">标准用户</span>'}。</p>
        <div class="quota-box">
          <div>隧道配额：<strong>\${escHtml(activeTunnels)} / \${escHtml(maxTunnels)}</strong> 条（活跃会话 \${escHtml(activeSessions)} 个）</div>
        </div>
        <div class="perm-row">
          <span class="perm-pill \${perms.managedTunnels ? "on" : "off"}">远程隧道：\${perms.managedTunnels ? "已开启" : "已关闭"}</span>
          <span class="perm-pill \${perms.webhooks ? "on" : "off"}">公网 Webhook：\${perms.webhooks ? "已开启" : "已关闭"}</span>
          <span class="perm-pill \${perms.mobilePush ? "on" : "off"}">推送通知：\${perms.mobilePush ? "已开启" : "已关闭"}</span>
        </div>
        \${STATE.hostedWebEnabled ? '<button class="primary" id="webAppBtn">打开 LunaCode 网页工作台</button>' : ""}
        \${isAdmin ? '<button class="secondary" id="adminBtn">进入超级管理控制台</button>' : ""}
        <div class="section">
          <h3>个人资料</h3>
          <form id="profileForm">
            <label>显示昵称</label>
            <input id="profileDisplayName" value="\${escHtml(currentUser.displayName || "")}" required maxlength="64" />
            <button class="secondary" type="submit">保存昵称</button>
          </form>
        </div>
        <div class="section">
          <h3>账号安全</h3>
          <form id="pwForm">
            <label>当前密码</label>
            <input id="currentPassword" type="password" required />
            <label>新密码（至少 8 位）</label>
            <input id="newPassword" type="password" required minlength="8" />
            <button class="secondary" type="submit">修改密码</button>
          </form>
          <button class="secondary" id="revokeSessionsBtn">注销其他设备会话</button>
          <button class="danger" id="logoutBtn">退出登录</button>
        </div>\`;
      if (STATE.hostedWebEnabled) {
        document.getElementById("webAppBtn").onclick = () => {
          window.location.href = "/";
        };
      }
      if (isAdmin) {
        document.getElementById("adminBtn").onclick = () => {
          window.location.href = "/admin";
        };
      }
      document.getElementById("profileForm").onsubmit = async (e) => {
        e.preventDefault();
        const res = await fetch("/api/auth/profile", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ displayName: document.getElementById("profileDisplayName").value }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) showMsg(data.message || data.error || "更新昵称失败", true);
        else {
          currentUser = data.user || currentUser;
          showMsg("昵称已更新", false);
          await render();
        }
      };
      document.getElementById("pwForm").onsubmit = async (e) => {
        e.preventDefault();
        const res = await fetch("/api/auth/change-password", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            currentPassword: document.getElementById("currentPassword").value,
            newPassword: document.getElementById("newPassword").value,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) showMsg(data.message || data.error || "修改密码失败", true);
        else {
          showMsg("密码已更新，其他设备会话已注销。", false);
          await render();
        }
      };
      document.getElementById("revokeSessionsBtn").onclick = async () => {
        const res = await fetch("/api/auth/revoke-other-sessions", { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) showMsg(data.message || data.error || "操作失败", true);
        else {
          showMsg("已注销其他设备会话与刷新令牌。", false);
          await render();
        }
      };
      document.getElementById("logoutBtn").onclick = async () => {
        await fetch("/api/auth/logout", { method: "POST" });
        currentUser = null;
        showMsg("已退出登录", false);
        await render();
      };
    }

    render();
  </script>
</body>
</html>`;
}
