import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  authenticateUserBearerOrSession,
  parseJsonBody,
  sendHtml,
  sendJson,
  type HttpContext,
} from "./authRoutes.ts";
import type { ConnectConfig } from "./config.ts";
import { hashPassword, type MintKeyPair, randomUuid } from "./crypto.ts";
import {
  type ConnectDatabase,
  DEFAULT_USER_PERMISSIONS,
  type UserPermissions,
  type UserRole,
  type UserRow,
} from "./db.ts";
import type { TunnelHub } from "./tunnelHub.ts";

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function requireAdmin(input: {
  readonly ctx: HttpContext;
  readonly config: ConnectConfig;
  readonly mintKeys: MintKeyPair;
  readonly db: ConnectDatabase;
}): UserRow | null {
  const user = authenticateUserBearerOrSession({
    req: input.ctx.req,
    config: input.config,
    mintKeys: input.mintKeys,
    db: input.db,
  });
  if (!user) {
    sendJson(input.ctx.res, 401, { error: "unauthenticated", message: "请先登录。" });
    return null;
  }
  if (user.role !== "admin") {
    sendJson(input.ctx.res, 403, { error: "forbidden", message: "需要超级管理员权限。" });
    return null;
  }
  return user;
}

function serializeUserPublic(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    maxTunnels: user.maxTunnels,
    permissions: user.permissions,
    disabledAt: user.disabledAt,
    createdAt: user.createdAt,
  };
}

function parsePermissionsPatch(
  raw: unknown,
): { readonly ok: true; readonly patch: Partial<UserPermissions> } | { readonly ok: false } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false };
  }
  const obj = raw as Record<string, unknown>;
  const patch: {
    managedTunnels?: boolean;
    webhooks?: boolean;
    mobilePush?: boolean;
  } = {};
  if (obj.managedTunnels !== undefined) {
    if (typeof obj.managedTunnels !== "boolean") return { ok: false };
    patch.managedTunnels = obj.managedTunnels;
  }
  if (obj.webhooks !== undefined) {
    if (typeof obj.webhooks !== "boolean") return { ok: false };
    patch.webhooks = obj.webhooks;
  }
  if (obj.mobilePush !== undefined) {
    if (typeof obj.mobilePush !== "boolean") return { ok: false };
    patch.mobilePush = obj.mobilePush;
  }
  return { ok: true, patch };
}

export async function handleAdminRoute(input: {
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

  if (method === "GET" && path === "/admin") {
    const user = authenticateUserBearerOrSession({ req, config, mintKeys, db });
    if (!user) {
      res.writeHead(302, {
        location: "/login?next=%2Fadmin",
        "cache-control": "no-store",
      });
      res.end();
      return true;
    }
    if (user.role !== "admin") {
      sendHtml(res, 403, renderForbiddenAdminHtml(user.email));
      return true;
    }
    sendHtml(res, 200, renderAdminConsoleHtml({ email: user.email, id: user.id }));
    return true;
  }

  if (method === "GET" && path === "/api/admin/overview") {
    const admin = requireAdmin({ ctx, config, mintKeys, db });
    if (!admin) return true;

    const users = db.listUsersForAdmin().map((entry) => ({
      ...entry,
      onlineTunnelCount: entry.activeTunnelIds.filter((id) => tunnelHub.hasActiveTunnel(id)).length,
    }));
    const environments = db.listAllActiveEnvironments().map((env) => ({
      environmentId: env.environmentId,
      userId: env.userId,
      userEmail: env.userEmail,
      userDisplayName: env.userDisplayName,
      label: env.label,
      providerKind: env.providerKind,
      httpBaseUrl: env.httpBaseUrl,
      wsBaseUrl: env.wsBaseUrl,
      tunnelId: env.tunnelId,
      tunnelSlug: env.tunnelSlug,
      online: env.tunnelId ? tunnelHub.hasActiveTunnel(env.tunnelId) : false,
      linkedAt: env.linkedAt,
      updatedAt: env.updatedAt,
    }));

    sendJson(res, 200, {
      currentAdmin: serializeUserPublic(admin),
      settings: {
        allowRegistration: db.resolveAllowRegistration(config.allowRegistration),
        allowedEmails: Array.from(db.resolveAllowedEmails(config.allowedEmails)),
      },
      stats: {
        totalUsers: users.length,
        activeAdmins: users.filter((u) => u.role === "admin" && u.disabledAt === null).length,
        disabledUsers: users.filter((u) => u.disabledAt !== null).length,
        totalEnvironments: environments.length,
        onlineTunnels: environments.filter((e) => e.online).length,
      },
      system: {
        wildcardDomain: config.tunnelWildcardDomain ?? null,
        hostedWebEnabled: Boolean(
          config.webDistDir && NodeFS.existsSync(NodePath.join(config.webDistDir, "index.html")),
        ),
        apnsConfigured: config.apns !== null,
        fcmConfigured: config.fcm !== null,
        heldWebhooksCount: db.countHeldWebhooks(),
      },
      users,
      environments,
    });
    return true;
  }

  if (method === "PATCH" && path === "/api/admin/settings") {
    const admin = requireAdmin({ ctx, config, mintKeys, db });
    if (!admin) return true;

    const payload = parseJsonBody(body);
    if (!payload) {
      sendJson(res, 400, { error: "invalid_request", message: "Invalid JSON body." });
      return true;
    }
    if (payload.allowRegistration !== undefined && typeof payload.allowRegistration !== "boolean") {
      sendJson(res, 400, {
        error: "invalid_request",
        message: "allowRegistration must be a boolean.",
      });
      return true;
    }

    let nextAllowedEmailsRaw: string | undefined;
    if (payload.allowedEmails !== undefined) {
      const list = Array.isArray(payload.allowedEmails)
        ? payload.allowedEmails
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim().toLowerCase())
            .filter((entry) => entry.length > 0)
        : typeof payload.allowedEmails === "string"
          ? payload.allowedEmails
              .split(",")
              .map((entry) => entry.trim().toLowerCase())
              .filter((entry) => entry.length > 0)
          : null;
      if (list === null) {
        sendJson(res, 400, {
          error: "invalid_request",
          message: "allowedEmails must be a comma-separated string or string array.",
        });
        return true;
      }
      nextAllowedEmailsRaw = Array.from(new Set(list)).join(",");
    }

    if (typeof payload.allowRegistration === "boolean") {
      db.setSetting("allow_registration", String(payload.allowRegistration));
    }
    if (nextAllowedEmailsRaw !== undefined) {
      db.setSetting("allowed_emails", nextAllowedEmailsRaw);
    }

    sendJson(res, 200, {
      allowRegistration: db.resolveAllowRegistration(config.allowRegistration),
      allowedEmails: Array.from(db.resolveAllowedEmails(config.allowedEmails)),
    });
    return true;
  }

  if (method === "POST" && path === "/api/admin/users") {
    const admin = requireAdmin({ ctx, config, mintKeys, db });
    if (!admin) return true;

    const payload = parseJsonBody(body);
    const email = typeof payload?.email === "string" ? payload.email.trim().toLowerCase() : "";
    const password = typeof payload?.password === "string" ? payload.password : "";
    const displayNameRaw =
      typeof payload?.displayName === "string" ? payload.displayName.trim() : "";
    const roleRaw = payload?.role;
    if (roleRaw !== undefined && roleRaw !== "admin" && roleRaw !== "user") {
      sendJson(res, 400, { error: "invalid_role", message: "角色必须是 admin 或 user。" });
      return true;
    }
    const role: UserRole = roleRaw === "admin" ? "admin" : "user";
    let maxTunnels = role === "admin" ? 100 : config.defaultUserMaxTunnels;
    if (payload?.maxTunnels !== undefined) {
      const parsedMax = Number(payload.maxTunnels);
      if (!Number.isInteger(parsedMax) || parsedMax < 0 || parsedMax > 10_000) {
        sendJson(res, 400, {
          error: "invalid_max_tunnels",
          message: "隧道配额上限必须是 0 到 10000 的整数。",
        });
        return true;
      }
      maxTunnels = parsedMax;
    }
    let permissions: UserPermissions = DEFAULT_USER_PERMISSIONS;
    if (payload?.permissions !== undefined) {
      const parsedPerm = parsePermissionsPatch(payload.permissions);
      if (!parsedPerm.ok) {
        sendJson(res, 400, { error: "invalid_permissions", message: "权限格式不正确。" });
        return true;
      }
      permissions = { ...DEFAULT_USER_PERMISSIONS, ...parsedPerm.patch };
    }
    if (!email || !email.includes("@")) {
      sendJson(res, 400, { error: "invalid_email", message: "请输入合法邮箱地址。" });
      return true;
    }
    if (password.length < 8) {
      sendJson(res, 400, { error: "weak_password", message: "密码长度至少 8 位。" });
      return true;
    }
    if (db.findUserByEmail(email)) {
      sendJson(res, 409, { error: "email_exists", message: "该邮箱已存在。" });
      return true;
    }

    const user: UserRow = {
      id: `usr_${randomUuid().replace(/-/g, "")}`,
      email,
      passwordHash: await hashPassword(password),
      displayName: displayNameRaw || email.split("@")[0] || email,
      role,
      maxTunnels,
      permissions,
      disabledAt: null,
      createdAt: new Date().toISOString(),
    };
    db.createUser(user);
    sendJson(res, 201, { user: serializeUserPublic(user) });
    return true;
  }

  const userMatch = /^\/api\/admin\/users\/([^/]+)$/u.exec(path);
  if (userMatch && method === "PATCH") {
    const admin = requireAdmin({ ctx, config, mintKeys, db });
    if (!admin) return true;

    const targetUserId = decodeURIComponent(userMatch[1]!);
    const target = db.findUserById(targetUserId);
    if (!target) {
      sendJson(res, 404, { error: "user_not_found", message: "用户不存在。" });
      return true;
    }

    const payload = parseJsonBody(body);
    if (!payload) {
      sendJson(res, 400, { error: "invalid_request", message: "Invalid JSON body." });
      return true;
    }

    let nextRole: UserRole | undefined;
    if (payload.role !== undefined) {
      if (payload.role !== "admin" && payload.role !== "user") {
        sendJson(res, 400, { error: "invalid_role", message: "角色必须是 admin 或 user。" });
        return true;
      }
      if (payload.role === "user" && target.id === admin.id) {
        sendJson(res, 400, {
          error: "cannot_demote_self",
          message: "不能取消当前登录管理员自己的超管权限。",
        });
        return true;
      }
      if (
        payload.role === "user" &&
        target.role === "admin" &&
        target.disabledAt === null &&
        db.countActiveAdmins() <= 1
      ) {
        sendJson(res, 400, {
          error: "last_admin",
          message: "不能降级最后一个有效超级管理员。",
        });
        return true;
      }
      nextRole = payload.role;
    }

    let nextDisabled: boolean | undefined;
    if (payload.disabled !== undefined) {
      if (typeof payload.disabled !== "boolean") {
        sendJson(res, 400, { error: "invalid_request", message: "disabled must be a boolean." });
        return true;
      }
      if (payload.disabled && target.id === admin.id) {
        sendJson(res, 400, {
          error: "cannot_disable_self",
          message: "不能禁用当前登录的超级管理员自己。",
        });
        return true;
      }
      if (
        payload.disabled &&
        target.role === "admin" &&
        target.disabledAt === null &&
        db.countActiveAdmins() <= 1
      ) {
        sendJson(res, 400, {
          error: "last_admin",
          message: "不能禁用最后一个有效超级管理员。",
        });
        return true;
      }
      nextDisabled = payload.disabled;
    }

    let nextPasswordHash: string | undefined;
    if (payload.password !== undefined) {
      if (typeof payload.password !== "string" || payload.password.length < 8) {
        sendJson(res, 400, { error: "weak_password", message: "新密码长度至少 8 位。" });
        return true;
      }
      nextPasswordHash = await hashPassword(payload.password);
    }

    let nextDisplayName: string | undefined;
    if (payload.displayName !== undefined) {
      if (typeof payload.displayName !== "string" || !payload.displayName.trim()) {
        sendJson(res, 400, { error: "invalid_request", message: "昵称不能为空。" });
        return true;
      }
      nextDisplayName = payload.displayName.trim();
    }

    let nextMaxTunnels: number | undefined;
    if (payload.maxTunnels !== undefined) {
      const parsedMax = Number(payload.maxTunnels);
      if (!Number.isInteger(parsedMax) || parsedMax < 0 || parsedMax > 10_000) {
        sendJson(res, 400, {
          error: "invalid_max_tunnels",
          message: "隧道配额上限必须是 0 到 10000 的整数。",
        });
        return true;
      }
      nextMaxTunnels = parsedMax;
    }

    let nextPermissions: Partial<UserPermissions> | undefined;
    if (payload.permissions !== undefined) {
      const parsedPerm = parsePermissionsPatch(payload.permissions);
      if (!parsedPerm.ok) {
        sendJson(res, 400, { error: "invalid_permissions", message: "权限格式不正确。" });
        return true;
      }
      nextPermissions = parsedPerm.patch;
    }

    if (nextDisplayName !== undefined) {
      db.updateUserDisplayName(target.id, nextDisplayName);
    }
    if (nextRole !== undefined) {
      db.updateUserRole(target.id, nextRole);
    }
    if (nextMaxTunnels !== undefined || nextPermissions !== undefined) {
      db.updateUserQuotaAndPermissions(target.id, {
        ...(nextMaxTunnels !== undefined ? { maxTunnels: nextMaxTunnels } : {}),
        ...(nextPermissions !== undefined ? { permissions: nextPermissions } : {}),
      });
    }
    if (nextPasswordHash !== undefined) {
      db.updateUserPassword(target.id, nextPasswordHash);
      db.revokeAllSessionsForUser(target.id);
      db.revokeAllRefreshTokensForUser(target.id);
    }
    if (nextDisabled !== undefined) {
      db.setUserDisabled(target.id, nextDisabled);
      if (nextDisabled) {
        db.revokeAllSessionsForUser(target.id);
        db.revokeAllRefreshTokensForUser(target.id);
        for (const tunnelId of db.listActiveTunnelIdsForUser(target.id)) {
          tunnelHub.closeTunnel(tunnelId, "Account disabled by admin");
        }
      }
    }

    const updated = db.findUserById(target.id);
    sendJson(res, 200, {
      user: updated ? serializeUserPublic(updated) : serializeUserPublic(target),
    });
    return true;
  }

  if (userMatch && method === "DELETE") {
    const admin = requireAdmin({ ctx, config, mintKeys, db });
    if (!admin) return true;

    const targetUserId = decodeURIComponent(userMatch[1]!);
    const target = db.findUserById(targetUserId);
    if (!target) {
      sendJson(res, 404, { error: "user_not_found", message: "用户不存在。" });
      return true;
    }
    if (target.id === admin.id) {
      sendJson(res, 400, {
        error: "cannot_delete_self",
        message: "不能删除当前登录的超级管理员自己。",
      });
      return true;
    }
    if (target.role === "admin" && target.disabledAt === null && db.countActiveAdmins() <= 1) {
      sendJson(res, 400, {
        error: "last_admin",
        message: "不能删除最后一个有效超级管理员。",
      });
      return true;
    }

    const tunnelIds = db.deleteUser(target.id);
    for (const tunnelId of tunnelIds) {
      tunnelHub.closeTunnel(tunnelId, "User deleted by admin");
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  const envDisconnectMatch = /^\/api\/admin\/environments\/([^/]+)\/([^/]+)\/disconnect$/u.exec(
    path,
  );
  if (envDisconnectMatch && method === "POST") {
    const admin = requireAdmin({ ctx, config, mintKeys, db });
    if (!admin) return true;

    const userId = decodeURIComponent(envDisconnectMatch[1]!);
    const environmentId = decodeURIComponent(envDisconnectMatch[2]!);
    const existing = db.getEnvironment(environmentId, userId);
    if (!existing || existing.revokedAt !== null) {
      sendJson(res, 404, { error: "environment_not_found", message: "设备或环境不存在。" });
      return true;
    }
    if (existing.tunnelId) {
      tunnelHub.closeTunnel(existing.tunnelId, "Disconnected by admin");
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  const envDeleteMatch = /^\/api\/admin\/environments\/([^/]+)\/([^/]+)$/u.exec(path);
  if (envDeleteMatch && method === "DELETE") {
    const admin = requireAdmin({ ctx, config, mintKeys, db });
    if (!admin) return true;

    const userId = decodeURIComponent(envDeleteMatch[1]!);
    const environmentId = decodeURIComponent(envDeleteMatch[2]!);
    const existing = db.getEnvironment(environmentId, userId);
    if (!existing || existing.revokedAt !== null) {
      sendJson(res, 404, { error: "environment_not_found", message: "设备或环境不存在。" });
      return true;
    }
    const tunnelId = db.revokeEnvironment(environmentId, userId);
    if (tunnelId) {
      tunnelHub.closeTunnel(tunnelId, "Revoked by admin");
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

function renderForbiddenAdminHtml(email: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>LunaCode Connect · 权限不足</title>
  <style>
    :root { color-scheme: dark; --bg:#0d1117; --card:#161b22; --border:#30363d; --fg:#f0f6fc; --muted:#8b949e; --danger:#f85149; }
    body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:var(--bg); color:var(--fg); min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; }
    .card { width:100%; max-width:440px; background:var(--card); border:1px solid var(--border); border-radius:14px; padding:24px; }
    h1 { margin:0 0 8px; font-size:20px; color:var(--danger); }
    p { margin:0 0 18px; color:var(--muted); font-size:13px; line-height:1.6; }
    .actions { display:flex; gap:10px; }
    a, button { flex:1; text-align:center; padding:10px 14px; border-radius:8px; font-size:13px; cursor:pointer; text-decoration:none; border:1px solid var(--border); background:transparent; color:var(--fg); }
  </style>
</head>
<body>
  <div class="card">
    <h1>无权访问管理控制台</h1>
    <p>当前账号 <strong>${escapeHtml(email)}</strong> 不是超级管理员，无法访问 /admin。</p>
    <div class="actions">
      <a href="/login">返回登录页</a>
      <button id="switchBtn">切换超管账号</button>
    </div>
  </div>
  <script>
    document.getElementById("switchBtn").onclick = async () => {
      await fetch("/api/auth/logout", { method: "POST" });
      window.location.href = "/login?next=%2Fadmin";
    };
  </script>
</body>
</html>`;
}

function renderAdminConsoleHtml(admin: { readonly email: string; readonly id: string }): string {
  const bootstrapJson = JSON.stringify(admin).replace(/</gu, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>LunaCode Connect · 超级管理控制台</title>
  <style>
    :root {
      color-scheme: dark;
      --bg:#0d1117;
      --card:#161b22;
      --card-alt:#0d1117;
      --border:#30363d;
      --fg:#f0f6fc;
      --muted:#8b949e;
      --accent:#58a6ff;
      --ok:#3fb950;
      --warn:#d29922;
      --danger:#f85149;
    }
    * { box-sizing:border-box; }
    body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:var(--bg); color:var(--fg); padding:24px; }
    .container { max-width:1160px; margin:0 auto; display:flex; flex-direction:column; gap:18px; }
    .topbar { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; background:var(--card); border:1px solid var(--border); border-radius:14px; padding:18px 20px; }
    .topbar h1 { margin:0; font-size:20px; display:flex; align-items:center; gap:8px; }
    .topbar-sub { font-size:13px; color:var(--muted); margin-top:4px; }
    .topbar-actions { display:flex; gap:8px; flex-wrap:wrap; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px; }
    .stat { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:14px 16px; }
    .stat-label { font-size:12px; color:var(--muted); }
    .stat-value { font-size:24px; font-weight:700; margin-top:6px; }
    .grid-2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:16px; }
    .panel { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:18px 20px; }
    .panel h2 { margin:0 0 12px; font-size:16px; }
    label { display:block; font-size:12px; color:var(--muted); margin-bottom:6px; }
    input, select { width:100%; padding:9px 11px; border-radius:8px; border:1px solid var(--border); background:var(--card-alt); color:var(--fg); font-size:13px; margin-bottom:12px; }
    .checkbox-row { display:flex; align-items:center; gap:8px; margin-bottom:12px; font-size:13px; cursor:pointer; }
    .checkbox-row input { width:auto; margin:0; }
    button, a.btn { padding:8px 12px; border-radius:8px; border:1px solid var(--border); background:transparent; color:var(--fg); font-size:12px; cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; gap:4px; }
    button.primary { background:#1f6feb; border-color:#1f6feb; color:#fff; font-weight:600; }
    button.danger { border-color:#f8514966; color:var(--danger); }
    button.warn { border-color:#d2992266; color:var(--warn); }
    button:disabled { opacity:.45; cursor:not-allowed; }
    .table-wrap { overflow-x:auto; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th, td { text-align:left; padding:10px 8px; border-bottom:1px solid var(--border); vertical-align:middle; }
    th { font-size:12px; color:var(--muted); font-weight:600; white-space:nowrap; }
    .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; border:1px solid var(--border); }
    .pill.admin { color:var(--accent); border-color:#388bfd66; background:#1f6feb22; }
    .pill.ok { color:var(--ok); border-color:#3fb95066; background:#2ea04322; }
    .pill.off { color:var(--danger); border-color:#f8514966; background:#f8514922; }
    .pill.muted { color:var(--muted); }
    .quota-edit { display:flex; align-items:center; gap:6px; white-space:nowrap; }
    .quota-edit input { width:68px; margin:0; padding:4px 6px; font-size:12px; text-align:center; }
    .perm-toggles { display:flex; flex-wrap:wrap; gap:4px; }
    .perm-btn { padding:3px 7px; font-size:11px; border-radius:999px; border:1px solid var(--border); }
    .perm-btn.on { color:var(--ok); border-color:#3fb95066; background:#2ea04322; }
    .perm-btn.off { color:var(--danger); border-color:#f8514955; background:#f8514915; }
    .sys-grid { display:flex; flex-wrap:wrap; gap:8px; }
    .row-actions { display:flex; flex-wrap:wrap; gap:6px; }
    .msg { font-size:13px; padding:10px 14px; border-radius:10px; border:1px solid var(--border); background:var(--card); display:none; }
    .msg.show { display:block; }
    .msg.ok { border-color:#3fb95066; color:var(--ok); }
    .msg.err { border-color:#f8514966; color:var(--danger); }
    code.url { font-size:12px; color:var(--accent); word-break:break-all; }
  </style>
</head>
<body>
  <div class="container">
    <div class="topbar">
      <div>
        <h1>LunaCode Connect <span class="pill admin">超级管理控制台</span></h1>
        <div class="topbar-sub">当前超管：<strong id="adminEmailLabel"></strong></div>
      </div>
      <div class="topbar-actions">
        <a class="btn" href="/">Web 工作台</a>
        <a class="btn" href="/login">返回门户</a>
        <button id="refreshBtn">刷新数据</button>
        <button id="logoutBtn">退出登录</button>
      </div>
    </div>

    <div id="statusMsg" class="msg"></div>

    <div class="stats" id="statsGrid"></div>
    <div class="panel" style="padding:12px 16px">
      <div class="sys-grid" id="systemStrip"></div>
    </div>

    <div class="grid-2">
      <div class="panel">
        <h2>注册与准入设置</h2>
        <form id="settingsForm">
          <label class="checkbox-row">
            <input type="checkbox" id="allowRegistrationInput" />
            <span>允许通过 /login 页面自行注册账号</span>
          </label>
          <label for="allowedEmailsInput">允许注册的邮箱白名单（英文逗号分隔，留空则不限制）</label>
          <input id="allowedEmailsInput" placeholder="user1@example.com, user2@example.com" />
          <button class="primary" type="submit">保存准入设置</button>
        </form>
      </div>

      <div class="panel">
        <h2>创建新用户</h2>
        <form id="createUserForm">
          <label for="newUserEmail">邮箱</label>
          <input id="newUserEmail" type="email" required placeholder="member@example.com" />
          <label for="newUserDisplayName">昵称（可选）</label>
          <input id="newUserDisplayName" placeholder="显示名称" />
          <label for="newUserPassword">初始密码（至少 8 位）</label>
          <input id="newUserPassword" type="password" required minlength="8" placeholder="至少 8 位" />
          <label for="newUserRole">角色</label>
          <select id="newUserRole">
            <option value="user">普通用户 (user)</option>
            <option value="admin">超级管理员 (admin)</option>
          </select>
          <label for="newUserMaxTunnels">隧道数量配额上限</label>
          <input id="newUserMaxTunnels" type="number" min="0" max="10000" value="3" />
          <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:8px;">
            <label class="checkbox-row"><input type="checkbox" id="newUserPermTunnels" checked /><span>远程隧道</span></label>
            <label class="checkbox-row"><input type="checkbox" id="newUserPermWebhooks" checked /><span>公网 Webhook</span></label>
            <label class="checkbox-row"><input type="checkbox" id="newUserPermPush" checked /><span>推送通知</span></label>
          </div>
          <button class="primary" type="submit">创建用户</button>
        </form>
      </div>
    </div>

    <div class="panel">
      <h2>用户管理</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>邮箱</th>
              <th>昵称</th>
              <th>角色</th>
              <th>状态</th>
              <th>隧道配额 (已用 / 上限)</th>
              <th>能力权限</th>
              <th>绑定设备 / 在线</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="usersTbody"></tbody>
        </table>
      </div>
    </div>

    <div class="panel">
      <h2>全站设备与在线隧道</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>所属用户</th>
              <th>设备名称</th>
              <th>连接方式</th>
              <th>隧道状态</th>
              <th>远程地址</th>
              <th>绑定时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="envsTbody"></tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    const BOOTSTRAP = ${bootstrapJson};
    const statusMsg = document.getElementById("statusMsg");
    const statsGrid = document.getElementById("statsGrid");
    const systemStrip = document.getElementById("systemStrip");
    const usersTbody = document.getElementById("usersTbody");
    const envsTbody = document.getElementById("envsTbody");
    document.getElementById("adminEmailLabel").textContent = BOOTSTRAP.email;
    document.getElementById("newUserRole").onchange = (e) => {
      document.getElementById("newUserMaxTunnels").value = e.target.value === "admin" ? "100" : "3";
    };

    function escHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function showStatus(text, isErr) {
      if (!text) {
        statusMsg.className = "msg";
        statusMsg.textContent = "";
        return;
      }
      statusMsg.textContent = text;
      statusMsg.className = "msg show " + (isErr ? "err" : "ok");
    }

    async function apiRequest(url, options) {
      const res = await fetch(url, options);
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        window.location.href = "/login?next=%2Fadmin";
        throw new Error("登录已过期，请重新登录。");
      }
      if (!res.ok) {
        throw new Error(data.message || data.error || ("请求失败 (" + res.status + ")"));
      }
      return data;
    }

    function renderOverview(data) {
      const stats = data.stats || {};
      const sys = data.system || {};
      statsGrid.innerHTML = [
        ["总用户数", stats.totalUsers ?? 0],
        ["有效超管", stats.activeAdmins ?? 0],
        ["已禁用账号", stats.disabledUsers ?? 0],
        ["已绑定设备", stats.totalEnvironments ?? 0],
        ["在线隧道", stats.onlineTunnels ?? 0],
      ].map(([label, val]) =>
        '<div class="stat"><div class="stat-label">' + escHtml(label) + '</div><div class="stat-value">' + escHtml(val) + '</div></div>'
      ).join("");

      systemStrip.innerHTML = [
        '<span class="pill ' + (sys.wildcardDomain ? "ok" : "muted") + '">隧道域名模式：' + escHtml(sys.wildcardDomain ? "*." + sys.wildcardDomain : "单域名路径前缀") + '</span>',
        '<span class="pill ' + (sys.hostedWebEnabled ? "ok" : "muted") + '">Web 托管端：' + (sys.hostedWebEnabled ? "已启用 (/)" : "未构建静态包") + '</span>',
        '<span class="pill ' + (sys.heldWebhooksCount > 0 ? "admin" : "muted") + '">离线暂存 Webhook：' + escHtml(sys.heldWebhooksCount ?? 0) + ' 条</span>',
        '<span class="pill ' + (sys.apnsConfigured ? "ok" : "muted") + '">APNs：' + (sys.apnsConfigured ? "已配置" : "未配置") + '</span>',
        '<span class="pill ' + (sys.fcmConfigured ? "ok" : "muted") + '">FCM：' + (sys.fcmConfigured ? "已配置" : "未配置") + '</span>',
      ].join("");

      document.getElementById("allowRegistrationInput").checked = Boolean(data.settings?.allowRegistration);
      document.getElementById("allowedEmailsInput").value = (data.settings?.allowedEmails || []).join(", ");

      const users = data.users || [];
      usersTbody.innerHTML = users.length === 0
        ? '<tr><td colspan="9" style="color:var(--muted)">暂无用户</td></tr>'
        : users.map((u) => {
            const isSelf = u.id === data.currentAdmin?.id;
            const isAdmin = u.role === "admin";
            const isDisabled = Boolean(u.disabledAt);
            const nextRole = isAdmin ? "user" : "admin";
            const perms = u.permissions || { managedTunnels: true, webhooks: true, mobilePush: true };
            const activeTunnels = u.activeTunnels ?? u.environmentCount ?? 0;
            const maxTunnels = u.maxTunnels ?? 3;
            return '<tr>' +
              '<td><strong>' + escHtml(u.email) + '</strong>' + (isSelf ? ' <span class="pill muted">当前</span>' : '') + '</td>' +
              '<td>' + escHtml(u.displayName) + '</td>' +
              '<td><span class="pill ' + (isAdmin ? "admin" : "muted") + '">' + escHtml(u.role) + '</span></td>' +
              '<td><span class="pill ' + (isDisabled ? "off" : "ok") + '">' + (isDisabled ? "已禁用" : "正常") + '</span></td>' +
              '<td><div class="quota-edit">' +
                '<span>' + escHtml(activeTunnels) + ' /</span>' +
                '<input type="number" min="0" max="10000" data-quota-user="' + escHtml(u.id) + '" value="' + escHtml(maxTunnels) + '" />' +
                '<button data-action="save-quota" data-user-id="' + escHtml(u.id) + '">保存</button>' +
              '</div></td>' +
              '<td><div class="perm-toggles">' +
                '<button class="perm-btn ' + (perms.managedTunnels ? "on" : "off") + '" data-action="toggle-perm" data-user-id="' + escHtml(u.id) + '" data-perm="managedTunnels" data-next="' + (!perms.managedTunnels) + '">隧道</button>' +
                '<button class="perm-btn ' + (perms.webhooks ? "on" : "off") + '" data-action="toggle-perm" data-user-id="' + escHtml(u.id) + '" data-perm="webhooks" data-next="' + (!perms.webhooks) + '">Webhook</button>' +
                '<button class="perm-btn ' + (perms.mobilePush ? "on" : "off") + '" data-action="toggle-perm" data-user-id="' + escHtml(u.id) + '" data-perm="mobilePush" data-next="' + (!perms.mobilePush) + '">推送</button>' +
              '</div></td>' +
              '<td>' + escHtml(u.environmentCount) + ' / ' + escHtml(u.onlineTunnelCount) + ' 在线</td>' +
              '<td>' + escHtml(String(u.createdAt || "").slice(0, 19).replace("T", " ")) + '</td>' +
              '<td><div class="row-actions">' +
                '<button data-action="role" data-user-id="' + escHtml(u.id) + '" data-next-role="' + escHtml(nextRole) + '"' + (isSelf && isAdmin ? " disabled" : "") + '>' + (isAdmin ? "降为普通用户" : "设为超管") + '</button>' +
                '<button data-action="reset-pw" data-user-id="' + escHtml(u.id) + '" data-email="' + escHtml(u.email) + '">重置密码</button>' +
                '<button class="warn" data-action="toggle-disable" data-user-id="' + escHtml(u.id) + '" data-disabled="' + (isDisabled ? "false" : "true") + '"' + (isSelf && !isDisabled ? " disabled" : "") + '>' + (isDisabled ? "启用" : "禁用") + '</button>' +
                '<button class="danger" data-action="delete-user" data-user-id="' + escHtml(u.id) + '" data-email="' + escHtml(u.email) + '"' + (isSelf ? " disabled" : "") + '>删除</button>' +
              '</div></td>' +
            '</tr>';
          }).join("");

      const envs = data.environments || [];
      envsTbody.innerHTML = envs.length === 0
        ? '<tr><td colspan="7" style="color:var(--muted)">暂无绑定设备</td></tr>'
        : envs.map((env) =>
            '<tr>' +
              '<td><div>' + escHtml(env.userEmail) + '</div><div style="font-size:11px;color:var(--muted)">' + escHtml(env.userDisplayName) + '</div></td>' +
              '<td>' + escHtml(env.label) + '</td>' +
              '<td>' + escHtml(env.providerKind) + '</td>' +
              '<td><span class="pill ' + (env.online ? "ok" : "muted") + '">' + (env.online ? "在线" : "离线") + '</span></td>' +
              '<td><code class="url">' + escHtml(env.httpBaseUrl) + '</code></td>' +
              '<td>' + escHtml(String(env.linkedAt || "").slice(0, 19).replace("T", " ")) + '</td>' +
              '<td><div class="row-actions">' +
                (env.online
                  ? '<button class="warn" data-action="disconnect-env" data-user-id="' + escHtml(env.userId) + '" data-env-id="' + escHtml(env.environmentId) + '">断开隧道</button>'
                  : '') +
                '<button class="danger" data-action="revoke-env" data-user-id="' + escHtml(env.userId) + '" data-env-id="' + escHtml(env.environmentId) + '" data-label="' + escHtml(env.label) + '">解绑设备</button>' +
              '</div></td>' +
            '</tr>'
          ).join("");
    }

    async function loadOverview() {
      try {
        const data = await apiRequest("/api/admin/overview");
        renderOverview(data);
      } catch (err) {
        showStatus(err.message, true);
      }
    }

    document.getElementById("refreshBtn").onclick = () => {
      showStatus("");
      void loadOverview();
    };

    document.getElementById("logoutBtn").onclick = async () => {
      await fetch("/api/auth/logout", { method: "POST" });
      window.location.href = "/login";
    };

    document.getElementById("settingsForm").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await apiRequest("/api/admin/settings", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            allowRegistration: document.getElementById("allowRegistrationInput").checked,
            allowedEmails: document.getElementById("allowedEmailsInput").value,
          }),
        });
        showStatus("注册与准入设置已保存。", false);
        await loadOverview();
      } catch (err) {
        showStatus(err.message, true);
      }
    };

    document.getElementById("createUserForm").onsubmit = async (e) => {
      e.preventDefault();
      try {
        const email = document.getElementById("newUserEmail").value;
        const displayName = document.getElementById("newUserDisplayName").value;
        const password = document.getElementById("newUserPassword").value;
        const role = document.getElementById("newUserRole").value;
        const maxTunnels = Number(document.getElementById("newUserMaxTunnels").value || (role === "admin" ? 100 : 3));
        const permissions = {
          managedTunnels: document.getElementById("newUserPermTunnels").checked,
          webhooks: document.getElementById("newUserPermWebhooks").checked,
          mobilePush: document.getElementById("newUserPermPush").checked,
        };
        await apiRequest("/api/admin/users", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, displayName, password, role, maxTunnels, permissions }),
        });
        document.getElementById("createUserForm").reset();
        document.getElementById("newUserMaxTunnels").value = "3";
        document.getElementById("newUserPermTunnels").checked = true;
        document.getElementById("newUserPermWebhooks").checked = true;
        document.getElementById("newUserPermPush").checked = true;
        showStatus("用户创建成功：" + email, false);
        await loadOverview();
      } catch (err) {
        showStatus(err.message, true);
      }
    };

    usersTbody.onclick = async (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn || btn.disabled) return;
      const action = btn.dataset.action;
      const userId = btn.dataset.userId;
      try {
        if (action === "save-quota") {
          const inputEl = usersTbody.querySelector('input[data-quota-user="' + CSS.escape(userId) + '"]');
          const maxTunnels = Number(inputEl?.value ?? 3);
          await apiRequest("/api/admin/users/" + encodeURIComponent(userId), {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ maxTunnels }),
          });
          showStatus("隧道配额上限已更新为 " + maxTunnels + "。", false);
        } else if (action === "toggle-perm") {
          const permKey = btn.dataset.perm;
          const nextVal = btn.dataset.next === "true";
          await apiRequest("/api/admin/users/" + encodeURIComponent(userId), {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ permissions: { [permKey]: nextVal } }),
          });
          showStatus("用户能力权限已更新。", false);
        } else if (action === "role") {
          await apiRequest("/api/admin/users/" + encodeURIComponent(userId), {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ role: btn.dataset.nextRole }),
          });
          showStatus("用户角色已更新。", false);
        } else if (action === "reset-pw") {
          const pw = window.prompt("请输入用户 " + (btn.dataset.email || "") + " 的新密码（至少 8 位）：");
          if (pw === null) return;
          if (pw.length < 8) {
            showStatus("新密码长度至少 8 位。", true);
            return;
          }
          await apiRequest("/api/admin/users/" + encodeURIComponent(userId), {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password: pw }),
          });
          showStatus("密码已重置并吊销旧会话。", false);
        } else if (action === "toggle-disable") {
          const disabled = btn.dataset.disabled === "true";
          await apiRequest("/api/admin/users/" + encodeURIComponent(userId), {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ disabled }),
          });
          showStatus(disabled ? "已禁用用户并断开其会话与隧道。" : "已重新启用用户。", false);
        } else if (action === "delete-user") {
          if (!window.confirm("确认永久删除用户 " + (btn.dataset.email || "") + " 及其全部绑定设备？此操作不可恢复。")) return;
          await apiRequest("/api/admin/users/" + encodeURIComponent(userId), { method: "DELETE" });
          showStatus("用户已删除。", false);
        }
        await loadOverview();
      } catch (err) {
        showStatus(err.message, true);
      }
    };

    envsTbody.onclick = async (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn || btn.disabled) return;
      const action = btn.dataset.action;
      const userId = encodeURIComponent(btn.dataset.userId);
      const envId = encodeURIComponent(btn.dataset.envId);
      try {
        if (action === "disconnect-env") {
          await apiRequest("/api/admin/environments/" + userId + "/" + envId + "/disconnect", {
            method: "POST",
          });
          showStatus("已强制断开在线隧道（设备稍后仍可重连）。", false);
        } else if (action === "revoke-env") {
          if (!window.confirm("确认解绑设备「" + (btn.dataset.label || "") + "」？")) return;
          await apiRequest("/api/admin/environments/" + userId + "/" + envId, {
            method: "DELETE",
          });
          showStatus("设备已解绑。", false);
        }
        await loadOverview();
      } catch (err) {
        showStatus(err.message, true);
      }
    };

    void loadOverview();
  </script>
</body>
</html>`;
}
