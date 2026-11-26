import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

export type UserRole = "admin" | "user";

export interface UserPermissions {
  readonly managedTunnels: boolean;
  readonly webhooks: boolean;
  readonly mobilePush: boolean;
}

export const DEFAULT_USER_PERMISSIONS: UserPermissions = {
  managedTunnels: true,
  webhooks: true,
  mobilePush: true,
};

export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly displayName: string;
  readonly role: UserRole;
  readonly maxTunnels: number;
  readonly permissions: UserPermissions;
  readonly disabledAt: string | null;
  readonly createdAt: string;
}

export type CreateUserInput = Omit<UserRow, "maxTunnels" | "permissions"> & {
  readonly maxTunnels?: number;
  readonly permissions?: UserPermissions;
};

export interface AdminUserSummary extends Omit<UserRow, "passwordHash"> {
  readonly environmentCount: number;
  readonly activeTunnels: number;
  readonly activeTunnelIds: ReadonlyArray<string>;
}

export interface HeldWebhookRow {
  readonly deliveryId: string;
  readonly environmentId: string;
  readonly userId: string;
  readonly hookId: string;
  readonly token: string;
  readonly method: string;
  readonly queryString: string;
  readonly headers: Record<string, string>;
  readonly bodyBase64: string;
  readonly receivedAt: string;
  readonly expiresAtMs: number;
  readonly attempts: number;
}

export interface StoredAgentActivity {
  readonly userId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly modelTitle: string;
  readonly phase: string;
  readonly headline: string;
  readonly detail: string | null;
  readonly updatedAt: string;
  readonly deepLink: string;
  readonly updatedAtMs: number;
}

export interface LiveActivityTokenRow {
  readonly userId: string;
  readonly deviceId: string;
  readonly activityPushToken: string;
  readonly updatedAt: string;
}

export interface FullMobileDeviceRow {
  readonly deviceId: string;
  readonly label: string;
  readonly platform: "ios" | "android";
  readonly iosMajorVersion?: number | null;
  readonly androidApiLevel?: number | null;
  readonly appVersion?: string | null;
  readonly bundleId?: string | null;
  readonly apsEnvironment?: "sandbox" | "production" | null;
  readonly pushToken?: string | null;
  readonly pushToStartToken?: string | null;
  readonly preferences?: {
    readonly liveActivitiesEnabled?: boolean;
    readonly notificationsEnabled?: boolean;
    readonly notifyOnApproval?: boolean;
    readonly notifyOnInput?: boolean;
    readonly notifyOnCompletion?: boolean;
    readonly notifyOnFailure?: boolean;
  };
  readonly updatedAt?: string;
}

export interface AdminEnvironmentSummary extends EnvironmentRow {
  readonly userEmail: string;
  readonly userDisplayName: string;
}

export interface SessionRow {
  readonly tokenHash: string;
  readonly userId: string;
  readonly expiresAt: number;
  readonly createdAt: string;
}

export interface OAuthCodeRow {
  readonly codeHash: string;
  readonly userId: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
  readonly scope: string;
  readonly expiresAt: number;
  readonly usedAt: string | null;
}

export interface DeviceCodeRow {
  readonly deviceCodeHash: string;
  readonly userCode: string;
  readonly clientId: string;
  readonly scope: string;
  readonly userId: string | null;
  readonly approvedAt: string | null;
  readonly denied: number;
  readonly expiresAt: number;
  readonly intervalSec: number;
}

export interface RefreshTokenRow {
  readonly tokenHash: string;
  readonly userId: string;
  readonly clientId: string;
  readonly scope: string;
  readonly expiresAt: number;
  readonly revokedAt: string | null;
}

export interface EnvironmentRow {
  readonly environmentId: string;
  readonly userId: string;
  readonly label: string;
  readonly environmentPublicKey: string;
  readonly environmentCredentialHash: string;
  readonly providerKind: "manual" | "t3_relay";
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly tunnelId: string | null;
  readonly tunnelName: string | null;
  readonly tunnelSlug: string | null;
  readonly tunnelHost: string | null;
  readonly connectorTokenHash: string | null;
  readonly holdWebhooksWhileOffline: number;
  readonly liveActivitiesEnabled: number;
  readonly notificationsEnabled: number;
  readonly revokedAt: string | null;
  readonly linkedAt: string;
  readonly updatedAt: string;
}

export class ConnectDatabase {
  readonly db: NodeSqlite.DatabaseSync;

  constructor(sqlitePath: string) {
    NodeFS.mkdirSync(NodePath.dirname(sqlitePath), { recursive: true });
    this.db = new NodeSqlite.DatabaseSync(sqlitePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        disabled_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_codes (
        code_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        code_challenge_method TEXT NOT NULL,
        scope TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at TEXT
      );

      CREATE TABLE IF NOT EXISTS device_codes (
        device_code_hash TEXT PRIMARY KEY,
        user_code TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        approved_at TEXT,
        denied INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL,
        interval_sec INTEGER NOT NULL DEFAULT 5
      );

      CREATE TABLE IF NOT EXISTS refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS environments (
        environment_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        environment_public_key TEXT NOT NULL,
        environment_credential_hash TEXT NOT NULL,
        provider_kind TEXT NOT NULL,
        http_base_url TEXT NOT NULL,
        ws_base_url TEXT NOT NULL,
        tunnel_id TEXT UNIQUE,
        tunnel_name TEXT,
        tunnel_slug TEXT,
        tunnel_host TEXT,
        connector_token_hash TEXT,
        hold_webhooks_while_offline INTEGER NOT NULL DEFAULT 0,
        live_activities_enabled INTEGER NOT NULL DEFAULT 1,
        notifications_enabled INTEGER NOT NULL DEFAULT 1,
        revoked_at TEXT,
        linked_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (environment_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_environments_tunnel_host
        ON environments (tunnel_host) WHERE revoked_at IS NULL;

      CREATE INDEX IF NOT EXISTS idx_environments_tunnel_slug
        ON environments (tunnel_slug) WHERE revoked_at IS NULL;

      CREATE TABLE IF NOT EXISTS mobile_devices (
        id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (id, user_id)
      );

      CREATE TABLE IF NOT EXISTS dpop_replays (
        thumbprint TEXT NOT NULL,
        jti TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (thumbprint, jti)
      );

      CREATE TABLE IF NOT EXISTS link_challenge_nonces (
        jti TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS held_webhooks (
        delivery_id TEXT PRIMARY KEY,
        environment_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        hook_id TEXT NOT NULL,
        token TEXT NOT NULL,
        method TEXT NOT NULL,
        query_string TEXT NOT NULL,
        headers_json TEXT NOT NULL,
        body_base64 TEXT NOT NULL,
        received_at TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_held_webhooks_env
        ON held_webhooks (environment_id, expires_at_ms);

      CREATE TABLE IF NOT EXISTS agent_activities (
        user_id TEXT NOT NULL,
        environment_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        project_title TEXT NOT NULL,
        thread_title TEXT NOT NULL,
        model_title TEXT NOT NULL,
        phase TEXT NOT NULL,
        headline TEXT NOT NULL,
        detail TEXT,
        updated_at TEXT NOT NULL,
        deep_link TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (user_id, environment_id, thread_id)
      );

      CREATE TABLE IF NOT EXISTS live_activities (
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        activity_push_token TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, device_id)
      );
    `);

    const userColumns = new Set(
      (this.db.prepare("PRAGMA table_info(users)").all() as Array<Record<string, unknown>>).map(
        (col) => String(col.name),
      ),
    );
    if (!userColumns.has("role")) {
      this.db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';");
    }
    if (!userColumns.has("disabled_at")) {
      this.db.exec("ALTER TABLE users ADD COLUMN disabled_at TEXT;");
    }
    if (!userColumns.has("max_tunnels")) {
      this.db.exec("ALTER TABLE users ADD COLUMN max_tunnels INTEGER NOT NULL DEFAULT 3;");
      this.db.exec("UPDATE users SET max_tunnels = 100 WHERE role = 'admin';");
    }
    if (!userColumns.has("permissions_json")) {
      this.db.exec(
        `ALTER TABLE users ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '{"managedTunnels":true,"webhooks":true,"mobilePush":true}';`,
      );
    }
  }

  close(): void {
    this.db.close();
  }

  findUserByEmail(email: string): UserRow | null {
    const row = this.db
      .prepare(
        "SELECT id, email, password_hash, display_name, role, max_tunnels, permissions_json, disabled_at, created_at FROM users WHERE email = ? LIMIT 1",
      )
      .get(email.toLowerCase()) as Record<string, unknown> | undefined;
    return row ? mapUserRow(row) : null;
  }

  findUserById(id: string): UserRow | null {
    const row = this.db
      .prepare(
        "SELECT id, email, password_hash, display_name, role, max_tunnels, permissions_json, disabled_at, created_at FROM users WHERE id = ? LIMIT 1",
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapUserRow(row) : null;
  }

  createUser(input: CreateUserInput): UserRow {
    const maxTunnels = input.maxTunnels ?? (input.role === "admin" ? 100 : 3);
    const permissions = normalizeUserPermissions(input.permissions);
    this.db
      .prepare(
        "INSERT INTO users (id, email, password_hash, display_name, role, max_tunnels, permissions_json, disabled_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.id,
        input.email.toLowerCase(),
        input.passwordHash,
        input.displayName,
        input.role,
        maxTunnels,
        JSON.stringify(permissions),
        input.disabledAt,
        input.createdAt,
      );
    return {
      ...input,
      email: input.email.toLowerCase(),
      maxTunnels,
      permissions,
    };
  }

  createSession(input: SessionRow): void {
    this.db
      .prepare(
        "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(input.tokenHash, input.userId, input.expiresAt, input.createdAt);
  }

  findValidSession(
    tokenHash: string,
    nowSec: number,
  ): (SessionRow & { readonly user: UserRow }) | null {
    const row = this.db
      .prepare(
        `SELECT s.token_hash, s.user_id, s.expires_at, s.created_at,
                u.email, u.password_hash, u.display_name, u.role, u.max_tunnels, u.permissions_json, u.disabled_at, u.created_at AS user_created_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled_at IS NULL LIMIT 1`,
      )
      .get(tokenHash, nowSec) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      tokenHash: String(row.token_hash),
      userId: String(row.user_id),
      expiresAt: Number(row.expires_at),
      createdAt: String(row.created_at),
      user: {
        id: String(row.user_id),
        email: String(row.email),
        passwordHash: String(row.password_hash),
        displayName: String(row.display_name),
        role: row.role === "admin" ? "admin" : "user",
        maxTunnels: Number.isFinite(Number(row.max_tunnels)) ? Number(row.max_tunnels) : 3,
        permissions: parsePermissionsJson(row.permissions_json),
        disabledAt: row.disabled_at ? String(row.disabled_at) : null,
        createdAt: String(row.user_created_at),
      },
    };
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  createOAuthCode(input: OAuthCodeRow): void {
    this.db
      .prepare(
        `INSERT INTO oauth_codes (
          code_hash, user_id, client_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at, used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        input.codeHash,
        input.userId,
        input.clientId,
        input.redirectUri,
        input.codeChallenge,
        input.codeChallengeMethod,
        input.scope,
        input.expiresAt,
      );
  }

  consumeOAuthCode(codeHash: string, nowSec: number): OAuthCodeRow | null {
    const row = this.db
      .prepare(
        `SELECT code_hash, user_id, client_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at, used_at
         FROM oauth_codes WHERE code_hash = ? LIMIT 1`,
      )
      .get(codeHash) as Record<string, unknown> | undefined;
    if (!row) return null;
    const mapped: OAuthCodeRow = {
      codeHash: String(row.code_hash),
      userId: String(row.user_id),
      clientId: String(row.client_id),
      redirectUri: String(row.redirect_uri),
      codeChallenge: String(row.code_challenge),
      codeChallengeMethod: String(row.code_challenge_method),
      scope: String(row.scope),
      expiresAt: Number(row.expires_at),
      usedAt: row.used_at ? String(row.used_at) : null,
    };
    if (mapped.usedAt !== null || mapped.expiresAt <= nowSec) {
      return null;
    }
    const result = this.db
      .prepare("UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL")
      .run(new Date().toISOString(), codeHash);
    return result.changes > 0 ? mapped : null;
  }

  createDeviceCode(input: Omit<DeviceCodeRow, "userId" | "approvedAt" | "denied">): void {
    this.db
      .prepare(
        `INSERT INTO device_codes (device_code_hash, user_code, client_id, scope, expires_at, interval_sec)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.deviceCodeHash,
        input.userCode,
        input.clientId,
        input.scope,
        input.expiresAt,
        input.intervalSec,
      );
  }

  findDeviceCodeByHash(deviceCodeHash: string): DeviceCodeRow | null {
    const row = this.db
      .prepare(
        `SELECT device_code_hash, user_code, client_id, scope, user_id, approved_at, denied, expires_at, interval_sec
         FROM device_codes WHERE device_code_hash = ? LIMIT 1`,
      )
      .get(deviceCodeHash) as Record<string, unknown> | undefined;
    return row ? mapDeviceCodeRow(row) : null;
  }

  findDeviceCodeByUserCode(userCode: string): DeviceCodeRow | null {
    const row = this.db
      .prepare(
        `SELECT device_code_hash, user_code, client_id, scope, user_id, approved_at, denied, expires_at, interval_sec
         FROM device_codes WHERE user_code = ? LIMIT 1`,
      )
      .get(userCode.toUpperCase()) as Record<string, unknown> | undefined;
    return row ? mapDeviceCodeRow(row) : null;
  }

  approveDeviceCode(userCode: string, userId: string, deny: boolean, nowSec: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE device_codes
         SET user_id = ?, approved_at = ?, denied = ?
         WHERE user_code = ? AND expires_at > ? AND approved_at IS NULL AND denied = 0`,
      )
      .run(
        userId,
        deny ? null : new Date().toISOString(),
        deny ? 1 : 0,
        userCode.toUpperCase(),
        nowSec,
      );
    return result.changes > 0;
  }

  deleteDeviceCode(deviceCodeHash: string): void {
    this.db.prepare("DELETE FROM device_codes WHERE device_code_hash = ?").run(deviceCodeHash);
  }

  createRefreshToken(input: RefreshTokenRow): void {
    this.db
      .prepare(
        `INSERT INTO refresh_tokens (token_hash, user_id, client_id, scope, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tokenHash,
        input.userId,
        input.clientId,
        input.scope,
        input.expiresAt,
        input.revokedAt,
      );
  }

  consumeRefreshToken(tokenHash: string, nowSec: number): RefreshTokenRow | null {
    const row = this.db
      .prepare(
        `SELECT token_hash, user_id, client_id, scope, expires_at, revoked_at
         FROM refresh_tokens WHERE token_hash = ? LIMIT 1`,
      )
      .get(tokenHash) as Record<string, unknown> | undefined;
    if (!row) return null;
    const mapped: RefreshTokenRow = {
      tokenHash: String(row.token_hash),
      userId: String(row.user_id),
      clientId: String(row.client_id),
      scope: String(row.scope),
      expiresAt: Number(row.expires_at),
      revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    };
    if (mapped.revokedAt !== null || mapped.expiresAt <= nowSec) {
      return null;
    }
    const result = this.db
      .prepare(
        "UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
      )
      .run(new Date().toISOString(), tokenHash);
    return result.changes > 0 ? mapped : null;
  }

  revokeRefreshToken(tokenHash: string): void {
    this.db
      .prepare(
        "UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
      )
      .run(new Date().toISOString(), tokenHash);
  }

  consumeReplayGuard(
    table: "dpop_replays",
    thumbprint: string,
    jti: string,
    expiresAt: number,
    nowSec: number,
  ): boolean {
    this.db.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`).run(nowSec);
    const result = this.db
      .prepare(`INSERT OR IGNORE INTO ${table} (thumbprint, jti, expires_at) VALUES (?, ?, ?)`)
      .run(thumbprint, jti, expiresAt);
    return result.changes > 0;
  }

  consumeLinkChallengeNonce(jti: string, expiresAt: number, nowSec: number): boolean {
    this.db.prepare("DELETE FROM link_challenge_nonces WHERE expires_at <= ?").run(nowSec);
    const result = this.db
      .prepare("INSERT OR IGNORE INTO link_challenge_nonces (jti, expires_at) VALUES (?, ?)")
      .run(jti, expiresAt);
    return result.changes > 0;
  }

  listEnvironmentsForUser(userId: string): ReadonlyArray<EnvironmentRow> {
    const rows = this.db
      .prepare(
        "SELECT * FROM environments WHERE user_id = ? AND revoked_at IS NULL ORDER BY linked_at DESC",
      )
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map(mapEnvironmentRow);
  }

  getEnvironment(environmentId: string, userId: string): EnvironmentRow | null {
    const row = this.db
      .prepare("SELECT * FROM environments WHERE environment_id = ? AND user_id = ? LIMIT 1")
      .get(environmentId, userId) as Record<string, unknown> | undefined;
    return row ? mapEnvironmentRow(row) : null;
  }

  findActiveEnvironmentByCredential(
    environmentId: string,
    credentialHash: string,
  ): EnvironmentRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM environments
         WHERE environment_id = ? AND environment_credential_hash = ? AND revoked_at IS NULL
         LIMIT 1`,
      )
      .get(environmentId, credentialHash) as Record<string, unknown> | undefined;
    return row ? mapEnvironmentRow(row) : null;
  }

  findActiveEnvironmentByTunnelAuth(
    tunnelId: string,
    connectorTokenHash: string,
  ): EnvironmentRow | null {
    const row = this.db
      .prepare(
        `SELECT e.* FROM environments e
         JOIN users u ON u.id = e.user_id
         WHERE e.tunnel_id = ? AND e.connector_token_hash = ? AND e.revoked_at IS NULL AND u.disabled_at IS NULL
         LIMIT 1`,
      )
      .get(tunnelId, connectorTokenHash) as Record<string, unknown> | undefined;
    return row ? mapEnvironmentRow(row) : null;
  }

  findActiveTunnelIdByHost(host: string): string | null {
    const normalized = host.split(":")[0]?.toLowerCase() ?? "";
    if (!normalized) return null;
    const row = this.db
      .prepare(
        `SELECT tunnel_id FROM environments
         WHERE tunnel_host = ? AND revoked_at IS NULL AND tunnel_id IS NOT NULL
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(normalized) as Record<string, unknown> | undefined;
    return row?.tunnel_id ? String(row.tunnel_id) : null;
  }

  findActiveTunnelIdBySlug(slug: string): string | null {
    const normalized = slug.trim().toLowerCase();
    if (!normalized) return null;
    const row = this.db
      .prepare(
        `SELECT tunnel_id FROM environments
         WHERE tunnel_slug = ? AND revoked_at IS NULL AND tunnel_id IS NOT NULL
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(normalized) as Record<string, unknown> | undefined;
    return row?.tunnel_id ? String(row.tunnel_id) : null;
  }

  upsertEnvironment(row: EnvironmentRow): void {
    this.db
      .prepare(
        `INSERT INTO environments (
          environment_id, user_id, label, environment_public_key, environment_credential_hash,
          provider_kind, http_base_url, ws_base_url, tunnel_id, tunnel_name, tunnel_slug,
          tunnel_host, connector_token_hash, hold_webhooks_while_offline, live_activities_enabled,
          notifications_enabled, revoked_at, linked_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(environment_id, user_id) DO UPDATE SET
          label = excluded.label,
          environment_public_key = excluded.environment_public_key,
          environment_credential_hash = excluded.environment_credential_hash,
          provider_kind = excluded.provider_kind,
          http_base_url = excluded.http_base_url,
          ws_base_url = excluded.ws_base_url,
          tunnel_id = excluded.tunnel_id,
          tunnel_name = excluded.tunnel_name,
          tunnel_slug = excluded.tunnel_slug,
          tunnel_host = excluded.tunnel_host,
          connector_token_hash = excluded.connector_token_hash,
          hold_webhooks_while_offline = excluded.hold_webhooks_while_offline,
          live_activities_enabled = excluded.live_activities_enabled,
          notifications_enabled = excluded.notifications_enabled,
          revoked_at = NULL,
          updated_at = excluded.updated_at`,
      )
      .run(
        row.environmentId,
        row.userId,
        row.label,
        row.environmentPublicKey,
        row.environmentCredentialHash,
        row.providerKind,
        row.httpBaseUrl,
        row.wsBaseUrl,
        row.tunnelId,
        row.tunnelName,
        row.tunnelSlug,
        row.tunnelHost,
        row.connectorTokenHash,
        row.holdWebhooksWhileOffline,
        row.liveActivitiesEnabled,
        row.notificationsEnabled,
        row.revokedAt,
        row.linkedAt,
        row.updatedAt,
      );
  }

  revokeEnvironment(environmentId: string, userId: string): string | null {
    const existing = this.getEnvironment(environmentId, userId);
    if (!existing || existing.revokedAt !== null) return null;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE environments
         SET revoked_at = ?, connector_token_hash = NULL, updated_at = ?
         WHERE environment_id = ? AND user_id = ?`,
      )
      .run(now, now, environmentId, userId);
    return existing.tunnelId;
  }

  releaseTunnelToken(environmentId: string, userId: string): string | null {
    const existing = this.getEnvironment(environmentId, userId);
    if (!existing || existing.revokedAt !== null) return null;
    this.db
      .prepare(
        `UPDATE environments
         SET connector_token_hash = NULL, updated_at = ?
         WHERE environment_id = ? AND user_id = ?`,
      )
      .run(new Date().toISOString(), environmentId, userId);
    return existing.tunnelId;
  }

  rotateTunnelToken(environmentId: string, userId: string, connectorTokenHash: string): void {
    this.db
      .prepare(
        `UPDATE environments
         SET connector_token_hash = ?, updated_at = ?
         WHERE environment_id = ? AND user_id = ?`,
      )
      .run(connectorTokenHash, new Date().toISOString(), environmentId, userId);
  }

  updateLinkPreferences(
    environmentId: string,
    userId: string,
    holdWebhooksWhileOffline: boolean,
  ): void {
    this.db
      .prepare(
        `UPDATE environments
         SET hold_webhooks_while_offline = ?, updated_at = ?
         WHERE environment_id = ? AND user_id = ?`,
      )
      .run(holdWebhooksWhileOffline ? 1 : 0, new Date().toISOString(), environmentId, userId);
  }

  updateLiveActivityPreference(environmentId: string, userId: string, enabled: boolean): boolean {
    const result = this.db
      .prepare(
        `UPDATE environments
         SET live_activities_enabled = ?, updated_at = ?
         WHERE environment_id = ? AND user_id = ? AND revoked_at IS NULL`,
      )
      .run(enabled ? 1 : 0, new Date().toISOString(), environmentId, userId);
    return result.changes > 0;
  }

  listDevicesForUser(userId: string): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare("SELECT record_json FROM mobile_devices WHERE user_id = ? ORDER BY updated_at DESC")
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map((row) => JSON.parse(String(row.record_json)) as Record<string, unknown>);
  }

  upsertDevice(userId: string, deviceId: string, record: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT INTO mobile_devices (id, user_id, record_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id, user_id) DO UPDATE SET
           record_json = excluded.record_json,
           updated_at = excluded.updated_at`,
      )
      .run(deviceId, userId, JSON.stringify(record), new Date().toISOString());
  }

  deleteDevice(userId: string, deviceId: string): void {
    this.db
      .prepare("DELETE FROM mobile_devices WHERE id = ? AND user_id = ?")
      .run(deviceId, userId);
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = ? LIMIT 1").get(key) as
      | Record<string, unknown>
      | undefined;
    return row ? String(row.value) : null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, new Date().toISOString());
  }

  resolveAllowRegistration(defaultValue: boolean): boolean {
    const raw = this.getSetting("allow_registration")?.trim().toLowerCase();
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    return defaultValue;
  }

  resolveAllowedEmails(defaultSet: ReadonlySet<string>): ReadonlySet<string> {
    const raw = this.getSetting("allowed_emails");
    if (raw === null) return defaultSet;
    return new Set(
      raw
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0),
    );
  }

  countUsers(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM users").get() as Record<
      string,
      unknown
    >;
    return Number(row?.cnt ?? 0);
  }

  countActiveAdmins(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'admin' AND disabled_at IS NULL")
      .get() as Record<string, unknown>;
    return Number(row?.cnt ?? 0);
  }

  promoteEmailsToAdmin(emails: Iterable<string>): number {
    let total = 0;
    const stmt = this.db.prepare(
      "UPDATE users SET role = 'admin', disabled_at = NULL, max_tunnels = CASE WHEN max_tunnels < 100 THEN 100 ELSE max_tunnels END WHERE email = ?",
    );
    for (const email of emails) {
      const normalized = email.trim().toLowerCase();
      if (!normalized) continue;
      const result = stmt.run(normalized);
      total += Number(result.changes ?? 0);
    }
    return total;
  }

  promoteEarliestUserToAdmin(): UserRow | null {
    const row = this.db
      .prepare("SELECT id FROM users ORDER BY created_at ASC, rowid ASC LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    if (!row?.id) return null;
    const userId = String(row.id);
    this.db
      .prepare(
        "UPDATE users SET role = 'admin', disabled_at = NULL, max_tunnels = CASE WHEN max_tunnels < 100 THEN 100 ELSE max_tunnels END WHERE id = ?",
      )
      .run(userId);
    return this.findUserById(userId);
  }

  listUsersForAdmin(): ReadonlyArray<AdminUserSummary> {
    const userRows = this.db
      .prepare(
        "SELECT id, email, display_name, role, max_tunnels, permissions_json, disabled_at, created_at FROM users ORDER BY created_at ASC, rowid ASC",
      )
      .all() as Array<Record<string, unknown>>;
    const envRows = this.db
      .prepare(
        "SELECT user_id, tunnel_id, provider_kind FROM environments WHERE revoked_at IS NULL",
      )
      .all() as Array<Record<string, unknown>>;

    const counts = new Map<string, number>();
    const managedCounts = new Map<string, number>();
    const tunnelsByUser = new Map<string, Array<string>>();
    for (const env of envRows) {
      const uid = String(env.user_id);
      counts.set(uid, (counts.get(uid) ?? 0) + 1);
      if (env.provider_kind === "t3_relay") {
        managedCounts.set(uid, (managedCounts.get(uid) ?? 0) + 1);
      }
      if (env.tunnel_id) {
        const list = tunnelsByUser.get(uid) ?? [];
        list.push(String(env.tunnel_id));
        tunnelsByUser.set(uid, list);
      }
    }

    return userRows.map((row) => {
      const id = String(row.id);
      return {
        id,
        email: String(row.email),
        displayName: String(row.display_name),
        role: row.role === "admin" ? "admin" : "user",
        maxTunnels: Number.isFinite(Number(row.max_tunnels)) ? Number(row.max_tunnels) : 3,
        permissions: parsePermissionsJson(row.permissions_json),
        disabledAt: row.disabled_at ? String(row.disabled_at) : null,
        createdAt: String(row.created_at),
        environmentCount: counts.get(id) ?? 0,
        activeTunnels: managedCounts.get(id) ?? 0,
        activeTunnelIds: tunnelsByUser.get(id) ?? [],
      };
    });
  }

  updateUserRole(userId: string, role: UserRole): boolean {
    const result = this.db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, userId);
    return Number(result.changes ?? 0) > 0;
  }

  updateUserQuotaAndPermissions(
    userId: string,
    input: {
      readonly maxTunnels?: number;
      readonly permissions?: Partial<UserPermissions>;
    },
  ): boolean {
    const existing = this.findUserById(userId);
    if (!existing) return false;
    const nextMaxTunnels =
      input.maxTunnels !== undefined
        ? Math.max(0, Math.min(10_000, Math.trunc(input.maxTunnels)))
        : existing.maxTunnels;
    const nextPermissions = normalizeUserPermissions({
      ...existing.permissions,
      ...input.permissions,
    });
    const result = this.db
      .prepare("UPDATE users SET max_tunnels = ?, permissions_json = ? WHERE id = ?")
      .run(nextMaxTunnels, JSON.stringify(nextPermissions), userId);
    return Number(result.changes ?? 0) > 0;
  }

  countActiveManagedTunnelsForUser(userId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS cnt FROM environments WHERE user_id = ? AND revoked_at IS NULL AND provider_kind = 't3_relay'",
      )
      .get(userId) as Record<string, unknown>;
    return Number(row?.cnt ?? 0);
  }

  countActiveSessionsForUser(userId: string, nowSec = Math.floor(Date.now() / 1_000)): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM sessions WHERE user_id = ? AND expires_at > ?")
      .get(userId, nowSec) as Record<string, unknown>;
    return Number(row?.cnt ?? 0);
  }

  revokeOtherSessionsForUser(userId: string, keepSessionHash: string | null): void {
    if (keepSessionHash) {
      this.db
        .prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?")
        .run(userId, keepSessionHash);
    } else {
      this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    }
    this.revokeAllRefreshTokensForUser(userId);
  }

  reconcileWildcardTunnelEndpoints(input: {
    readonly wildcardDomain: string;
    readonly scheme: "https" | "http";
    readonly portSuffix: string;
  }): number {
    const rows = this.db
      .prepare("SELECT * FROM environments WHERE provider_kind = 't3_relay' AND revoked_at IS NULL")
      .all() as Array<Record<string, unknown>>;
    let updated = 0;
    const wsScheme = input.scheme === "https" ? "wss" : "ws";
    const domain = input.wildcardDomain.trim().replace(/^\*\./u, "").toLowerCase();
    if (!domain) return 0;

    const stmt = this.db.prepare(
      `UPDATE environments
       SET tunnel_name = ?, tunnel_slug = ?, tunnel_host = ?, http_base_url = ?, ws_base_url = ?, updated_at = ?
       WHERE environment_id = ? AND user_id = ?`,
    );

    for (const raw of rows) {
      const env = mapEnvironmentRow(raw);
      const endpointKey = sha256HexString(`${env.userId}:${env.environmentId}`).slice(0, 16);
      const nextSlug = env.tunnelSlug?.trim() || `env-${endpointKey}`;
      const nextName =
        env.tunnelName && /-[0-9a-f]{16}$/iu.test(env.tunnelName)
          ? env.tunnelName
          : `lunacode-${endpointKey}`;
      const expectedHost = `${nextSlug}.${domain}`;
      const expectedHttp = `${input.scheme}://${expectedHost}${input.portSuffix}/`;
      const expectedWs = `${wsScheme}://${expectedHost}${input.portSuffix}/`;
      const needsHostMigration =
        env.tunnelHost !== expectedHost ||
        env.httpBaseUrl !== expectedHttp ||
        env.wsBaseUrl !== expectedWs ||
        env.tunnelName !== nextName ||
        env.tunnelSlug !== nextSlug;
      if (!needsHostMigration) continue;
      stmt.run(
        nextName,
        nextSlug,
        expectedHost,
        expectedHttp,
        expectedWs,
        new Date().toISOString(),
        env.environmentId,
        env.userId,
      );
      updated += 1;
    }
    return updated;
  }

  findActiveEnvironmentByEndpointKey(endpointKey: string): EnvironmentRow | null {
    const key = endpointKey.trim().toLowerCase();
    if (!key) return null;
    const rows = this.db
      .prepare(
        "SELECT * FROM environments WHERE provider_kind = 't3_relay' AND revoked_at IS NULL ORDER BY updated_at DESC",
      )
      .all() as Array<Record<string, unknown>>;
    for (const raw of rows) {
      const env = mapEnvironmentRow(raw);
      const nameSuffix = env.tunnelName?.split("-").at(-1)?.toLowerCase();
      const slugSuffix = env.tunnelSlug?.split("-").at(-1)?.toLowerCase();
      if (nameSuffix === key || slugSuffix === key) {
        return env;
      }
    }
    return null;
  }

  enqueueHeldWebhook(
    input: Omit<HeldWebhookRow, "headers" | "attempts"> & {
      readonly headers: Record<string, string>;
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO held_webhooks (
          delivery_id, environment_id, user_id, hook_id, token, method, query_string,
          headers_json, body_base64, received_at, expires_at_ms, attempts
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        input.deliveryId,
        input.environmentId,
        input.userId,
        input.hookId,
        input.token,
        input.method,
        input.queryString,
        JSON.stringify(input.headers),
        input.bodyBase64,
        input.receivedAt,
        input.expiresAtMs,
      );

    // Cap held queue to 200 entries per environment by evicting the oldest ones.
    const countRow = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM held_webhooks WHERE environment_id = ?")
      .get(input.environmentId) as Record<string, unknown>;
    const count = Number(countRow?.cnt ?? 0);
    if (count > 200) {
      this.db
        .prepare(
          `DELETE FROM held_webhooks
           WHERE delivery_id IN (
             SELECT delivery_id FROM held_webhooks
             WHERE environment_id = ?
             ORDER BY received_at ASC, rowid ASC
             LIMIT ?
           )`,
        )
        .run(input.environmentId, count - 200);
    }
  }

  listHeldWebhooksForEnvironment(
    environmentId: string,
    nowMs = Date.now(),
  ): ReadonlyArray<HeldWebhookRow> {
    this.db
      .prepare("DELETE FROM held_webhooks WHERE environment_id = ? AND expires_at_ms <= ?")
      .run(environmentId, nowMs);
    const rows = this.db
      .prepare(
        "SELECT * FROM held_webhooks WHERE environment_id = ? ORDER BY received_at ASC, rowid ASC",
      )
      .all(environmentId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      deliveryId: String(row.delivery_id),
      environmentId: String(row.environment_id),
      userId: String(row.user_id),
      hookId: String(row.hook_id),
      token: String(row.token),
      method: String(row.method),
      queryString: String(row.query_string),
      headers: parseStringRecordJson(row.headers_json),
      bodyBase64: String(row.body_base64),
      receivedAt: String(row.received_at),
      expiresAtMs: Number(row.expires_at_ms),
      attempts: Number(row.attempts),
    }));
  }

  deleteHeldWebhook(deliveryId: string): void {
    this.db.prepare("DELETE FROM held_webhooks WHERE delivery_id = ?").run(deliveryId);
  }

  incrementHeldWebhookAttempt(deliveryId: string, maxAttempts = 10): boolean {
    const row = this.db
      .prepare("SELECT attempts FROM held_webhooks WHERE delivery_id = ? LIMIT 1")
      .get(deliveryId) as Record<string, unknown> | undefined;
    if (!row) return false;
    const next = Number(row.attempts ?? 0) + 1;
    if (next >= maxAttempts) {
      this.deleteHeldWebhook(deliveryId);
      return false;
    }
    this.db
      .prepare("UPDATE held_webhooks SET attempts = ? WHERE delivery_id = ?")
      .run(next, deliveryId);
    return true;
  }

  pruneExpiredHeldWebhooks(nowMs = Date.now()): void {
    this.db.prepare("DELETE FROM held_webhooks WHERE expires_at_ms <= ?").run(nowMs);
  }

  countHeldWebhooks(nowMs = Date.now()): number {
    this.pruneExpiredHeldWebhooks(nowMs);
    const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM held_webhooks").get() as Record<
      string,
      unknown
    >;
    return Number(row?.cnt ?? 0);
  }

  upsertAgentActivity(row: StoredAgentActivity): void {
    this.db
      .prepare(
        `INSERT INTO agent_activities (
          user_id, environment_id, thread_id, project_title, thread_title, model_title,
          phase, headline, detail, updated_at, deep_link, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, environment_id, thread_id) DO UPDATE SET
          project_title = excluded.project_title,
          thread_title = excluded.thread_title,
          model_title = excluded.model_title,
          phase = excluded.phase,
          headline = excluded.headline,
          detail = excluded.detail,
          updated_at = excluded.updated_at,
          deep_link = excluded.deep_link,
          updated_at_ms = excluded.updated_at_ms`,
      )
      .run(
        row.userId,
        row.environmentId,
        row.threadId,
        row.projectTitle,
        row.threadTitle,
        row.modelTitle,
        row.phase,
        row.headline,
        row.detail,
        row.updatedAt,
        row.deepLink,
        row.updatedAtMs,
      );
  }

  deleteAgentActivity(userId: string, environmentId: string, threadId: string): void {
    this.db
      .prepare(
        "DELETE FROM agent_activities WHERE user_id = ? AND environment_id = ? AND thread_id = ?",
      )
      .run(userId, environmentId, threadId);
  }

  getAgentActivity(
    userId: string,
    environmentId: string,
    threadId: string,
  ): StoredAgentActivity | null {
    const row = this.db
      .prepare(
        `SELECT * FROM agent_activities
         WHERE user_id = ? AND environment_id = ? AND thread_id = ? LIMIT 1`,
      )
      .get(userId, environmentId, threadId) as Record<string, unknown> | undefined;
    return row ? mapAgentActivityRow(row) : null;
  }

  listAgentActivitiesForUser(
    userId: string,
    maxAgeMs = 24 * 60 * 60 * 1_000,
    nowMs = Date.now(),
  ): ReadonlyArray<StoredAgentActivity> {
    const minUpdatedAtMs = nowMs - maxAgeMs;
    this.db
      .prepare("DELETE FROM agent_activities WHERE user_id = ? AND updated_at_ms < ?")
      .run(userId, minUpdatedAtMs);
    const rows = this.db
      .prepare(
        "SELECT * FROM agent_activities WHERE user_id = ? AND updated_at_ms >= ? ORDER BY updated_at_ms DESC",
      )
      .all(userId, minUpdatedAtMs) as Array<Record<string, unknown>>;
    return rows.map(mapAgentActivityRow);
  }

  upsertLiveActivityToken(userId: string, deviceId: string, activityPushToken: string): void {
    this.db
      .prepare(
        `INSERT INTO live_activities (user_id, device_id, activity_push_token, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, device_id) DO UPDATE SET
           activity_push_token = excluded.activity_push_token,
           updated_at = excluded.updated_at`,
      )
      .run(userId, deviceId, activityPushToken, new Date().toISOString());
  }

  listLiveActivityTokensForUser(userId: string): ReadonlyArray<LiveActivityTokenRow> {
    const rows = this.db
      .prepare("SELECT * FROM live_activities WHERE user_id = ? ORDER BY updated_at DESC")
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      userId: String(row.user_id),
      deviceId: String(row.device_id),
      activityPushToken: String(row.activity_push_token),
      updatedAt: String(row.updated_at),
    }));
  }

  deleteLiveActivityToken(userId: string, deviceId: string): void {
    this.db
      .prepare("DELETE FROM live_activities WHERE user_id = ? AND device_id = ?")
      .run(userId, deviceId);
  }

  listFullDevicesForUser(userId: string): ReadonlyArray<FullMobileDeviceRow> {
    const rows = this.db
      .prepare("SELECT record_json FROM mobile_devices WHERE user_id = ? ORDER BY updated_at DESC")
      .all(userId) as Array<Record<string, unknown>>;
    return rows
      .map((row) => {
        try {
          return JSON.parse(String(row.record_json)) as FullMobileDeviceRow;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is FullMobileDeviceRow => entry !== null);
  }

  clearDevicePushToken(userId: string, deviceId: string): void {
    const row = this.db
      .prepare("SELECT record_json FROM mobile_devices WHERE id = ? AND user_id = ? LIMIT 1")
      .get(deviceId, userId) as Record<string, unknown> | undefined;
    if (!row) return;
    try {
      const parsed = JSON.parse(String(row.record_json)) as Record<string, unknown>;
      delete parsed.pushToken;
      delete parsed.pushToStartToken;
      this.upsertDevice(userId, deviceId, parsed);
    } catch {
      // ignore malformed JSON
    }
  }

  updateUserDisplayName(userId: string, displayName: string): boolean {
    const result = this.db
      .prepare("UPDATE users SET display_name = ? WHERE id = ?")
      .run(displayName, userId);
    return Number(result.changes ?? 0) > 0;
  }

  updateUserPassword(userId: string, passwordHash: string): boolean {
    const result = this.db
      .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .run(passwordHash, userId);
    return Number(result.changes ?? 0) > 0;
  }

  setUserDisabled(userId: string, disabled: boolean): boolean {
    const disabledAt = disabled ? new Date().toISOString() : null;
    const result = this.db
      .prepare("UPDATE users SET disabled_at = ? WHERE id = ?")
      .run(disabledAt, userId);
    return Number(result.changes ?? 0) > 0;
  }

  revokeAllSessionsForUser(userId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }

  revokeAllRefreshTokensForUser(userId: string): void {
    this.db
      .prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
      .run(new Date().toISOString(), userId);
  }

  listActiveTunnelIdsForUser(userId: string): ReadonlyArray<string> {
    const rows = this.db
      .prepare(
        "SELECT tunnel_id FROM environments WHERE user_id = ? AND revoked_at IS NULL AND tunnel_id IS NOT NULL",
      )
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map((row) => String(row.tunnel_id));
  }

  deleteUser(userId: string): ReadonlyArray<string> {
    const tunnelIds = this.listActiveTunnelIdsForUser(userId);
    this.db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    return tunnelIds;
  }

  listAllActiveEnvironments(): ReadonlyArray<AdminEnvironmentSummary> {
    const rows = this.db
      .prepare(
        `SELECT e.*, u.email AS user_email, u.display_name AS user_display_name
         FROM environments e
         JOIN users u ON u.id = e.user_id
         WHERE e.revoked_at IS NULL
         ORDER BY e.linked_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...mapEnvironmentRow(row),
      userEmail: String(row.user_email),
      userDisplayName: String(row.user_display_name),
    }));
  }
}

function sha256HexString(input: string): string {
  return NodeCrypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function normalizeUserPermissions(input?: Partial<UserPermissions>): UserPermissions {
  return {
    managedTunnels: input?.managedTunnels ?? DEFAULT_USER_PERMISSIONS.managedTunnels,
    webhooks: input?.webhooks ?? DEFAULT_USER_PERMISSIONS.webhooks,
    mobilePush: input?.mobilePush ?? DEFAULT_USER_PERMISSIONS.mobilePush,
  };
}

function parsePermissionsJson(raw: unknown): UserPermissions {
  if (typeof raw !== "string" || !raw.trim()) return DEFAULT_USER_PERMISSIONS;
  try {
    const parsed = JSON.parse(raw) as Partial<UserPermissions>;
    return normalizeUserPermissions({
      managedTunnels:
        typeof parsed.managedTunnels === "boolean" ? parsed.managedTunnels : undefined,
      webhooks: typeof parsed.webhooks === "boolean" ? parsed.webhooks : undefined,
      mobilePush: typeof parsed.mobilePush === "boolean" ? parsed.mobilePush : undefined,
    });
  } catch {
    return DEFAULT_USER_PERMISSIONS;
  }
}

function parseStringRecordJson(raw: unknown): Record<string, string> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function mapUserRow(row: Record<string, unknown>): UserRow {
  return {
    id: String(row.id),
    email: String(row.email),
    passwordHash: String(row.password_hash),
    displayName: String(row.display_name),
    role: row.role === "admin" ? "admin" : "user",
    maxTunnels: Number.isFinite(Number(row.max_tunnels)) ? Number(row.max_tunnels) : 3,
    permissions: parsePermissionsJson(row.permissions_json),
    disabledAt: row.disabled_at ? String(row.disabled_at) : null,
    createdAt: String(row.created_at),
  };
}

function mapAgentActivityRow(row: Record<string, unknown>): StoredAgentActivity {
  return {
    userId: String(row.user_id),
    environmentId: String(row.environment_id),
    threadId: String(row.thread_id),
    projectTitle: String(row.project_title),
    threadTitle: String(row.thread_title),
    modelTitle: String(row.model_title),
    phase: String(row.phase),
    headline: String(row.headline),
    detail: row.detail !== null && row.detail !== undefined ? String(row.detail) : null,
    updatedAt: String(row.updated_at),
    deepLink: String(row.deep_link),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function mapDeviceCodeRow(row: Record<string, unknown>): DeviceCodeRow {
  return {
    deviceCodeHash: String(row.device_code_hash),
    userCode: String(row.user_code),
    clientId: String(row.client_id),
    scope: String(row.scope),
    userId: row.user_id ? String(row.user_id) : null,
    approvedAt: row.approved_at ? String(row.approved_at) : null,
    denied: Number(row.denied),
    expiresAt: Number(row.expires_at),
    intervalSec: Number(row.interval_sec),
  };
}

function mapEnvironmentRow(row: Record<string, unknown>): EnvironmentRow {
  return {
    environmentId: String(row.environment_id),
    userId: String(row.user_id),
    label: String(row.label),
    environmentPublicKey: String(row.environment_public_key),
    environmentCredentialHash: String(row.environment_credential_hash),
    providerKind: row.provider_kind === "t3_relay" ? "t3_relay" : "manual",
    httpBaseUrl: String(row.http_base_url),
    wsBaseUrl: String(row.ws_base_url),
    tunnelId: row.tunnel_id ? String(row.tunnel_id) : null,
    tunnelName: row.tunnel_name ? String(row.tunnel_name) : null,
    tunnelSlug: row.tunnel_slug ? String(row.tunnel_slug) : null,
    tunnelHost: row.tunnel_host ? String(row.tunnel_host) : null,
    connectorTokenHash: row.connector_token_hash ? String(row.connector_token_hash) : null,
    holdWebhooksWhileOffline: Number(row.hold_webhooks_while_offline),
    liveActivitiesEnabled: Number(row.live_activities_enabled),
    notificationsEnabled: Number(row.notifications_enabled),
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    linkedAt: String(row.linked_at),
    updatedAt: String(row.updated_at),
  };
}
