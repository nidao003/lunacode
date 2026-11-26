import * as NodeCrypto from "node:crypto";
import * as NodeHttp2 from "node:http2";

import type { ApnsPushConfig, ConnectConfig, FcmPushConfig } from "./config.ts";
import type { ConnectDatabase, StoredAgentActivity } from "./db.ts";

export interface AgentActivityAggregateRow {
  readonly environmentId: string;
  readonly threadId: string;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly modelTitle: string;
  readonly phase: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly deepLink: string;
}

export interface AgentActivityAggregateState {
  readonly title: string;
  readonly subtitle: string;
  readonly activeCount: number;
  readonly updatedAt: string;
  readonly activities: ReadonlyArray<AgentActivityAggregateRow>;
}

export interface RelayDeliveryResult {
  readonly deviceId: string;
  readonly kind:
    | "live_activity_start"
    | "live_activity_update"
    | "live_activity_end"
    | "push_notification";
  readonly ok: boolean;
  readonly queued?: boolean;
  readonly apnsStatus: number | null;
  readonly apnsReason: string | null;
  readonly apnsId: string | null;
}

const ACTIVE_PHASES = new Set(["starting", "running", "waiting_for_approval", "waiting_for_input"]);

const ALERT_PHASES = new Set(["waiting_for_approval", "waiting_for_input", "completed", "failed"]);

const PHASE_PRIORITY: Record<string, number> = {
  waiting_for_approval: 0,
  waiting_for_input: 1,
  failed: 2,
  running: 3,
  starting: 4,
  completed: 5,
  stale: 6,
};

let cachedApnsJwt: {
  readonly token: string;
  readonly expiresAtMs: number;
  readonly cacheKey: string;
} | null = null;
let cachedFcmAccess: {
  readonly token: string;
  readonly expiresAtMs: number;
  readonly cacheKey: string;
} | null = null;

export function buildAgentActivityAggregate(
  activities: ReadonlyArray<StoredAgentActivity>,
): AgentActivityAggregateState | null {
  const cutoff = Date.now() - 24 * 60 * 60 * 1_000;
  const fresh = activities.filter((entry) => entry.updatedAtMs >= cutoff);
  if (fresh.length === 0) return null;

  const sorted = [...fresh].sort((a, b) => {
    const rankA = PHASE_PRIORITY[a.phase] ?? 7;
    const rankB = PHASE_PRIORITY[b.phase] ?? 7;
    if (rankA !== rankB) return rankA - rankB;
    return b.updatedAtMs - a.updatedAtMs;
  });

  let activeCount = 0;
  let newest = sorted[0]!;
  for (const row of sorted) {
    if (ACTIVE_PHASES.has(row.phase)) {
      activeCount += 1;
    }
    if (row.updatedAtMs > newest.updatedAtMs) {
      newest = row;
    }
  }

  const lead = sorted[0]!;
  const title =
    lead.phase === "waiting_for_approval"
      ? "等待批准"
      : lead.phase === "waiting_for_input"
        ? "等待输入"
        : lead.phase === "failed"
          ? "任务异常"
          : activeCount > 0
            ? `正在运行 (${activeCount})`
            : "任务已完成";

  const subtitle = `${lead.threadTitle} · ${lead.headline}`.slice(0, 180);

  return {
    title,
    subtitle,
    activeCount,
    updatedAt: newest.updatedAt,
    activities: sorted.map((row) => ({
      environmentId: row.environmentId,
      threadId: row.threadId,
      projectTitle: row.projectTitle,
      threadTitle: row.threadTitle,
      modelTitle: row.modelTitle,
      phase: row.phase,
      status: row.headline,
      updatedAt: row.updatedAt,
      deepLink: row.deepLink,
    })),
  };
}

function shouldNotifyForPhase(
  phase: string,
  preferences:
    | {
        readonly notificationsEnabled?: boolean;
        readonly notifyOnApproval?: boolean;
        readonly notifyOnInput?: boolean;
        readonly notifyOnCompletion?: boolean;
        readonly notifyOnFailure?: boolean;
      }
    | undefined,
): boolean {
  if (preferences?.notificationsEnabled === false) return false;
  switch (phase) {
    case "waiting_for_approval":
      return preferences?.notifyOnApproval !== false;
    case "waiting_for_input":
      return preferences?.notifyOnInput !== false;
    case "completed":
      return preferences?.notifyOnCompletion !== false;
    case "failed":
      return preferences?.notifyOnFailure !== false;
    default:
      return false;
  }
}

function formatAlertCopy(state: {
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly phase: string;
  readonly headline: string;
}): { readonly title: string; readonly body: string } {
  const phaseLabel =
    state.phase === "waiting_for_approval"
      ? "等待操作批准"
      : state.phase === "waiting_for_input"
        ? "等待你的输入"
        : state.phase === "failed"
          ? "执行失败"
          : "任务已完成";
  return {
    title: `${state.projectTitle} · ${phaseLabel}`,
    body: `${state.threadTitle}: ${state.headline}`.slice(0, 200),
  };
}

function getApnsProviderJwt(apns: ApnsPushConfig): string {
  const nowMs = Date.now();
  const cacheKey = `${apns.teamId}:${apns.keyId}`;
  if (cachedApnsJwt && cachedApnsJwt.cacheKey === cacheKey && cachedApnsJwt.expiresAtMs > nowMs) {
    return cachedApnsJwt.token;
  }
  const nowSec = Math.floor(nowMs / 1_000);
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: apns.keyId }), "utf8").toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify({ iss: apns.teamId, iat: nowSec }), "utf8").toString(
    "base64url",
  );
  const signingInput = `${header}.${payload}`;
  const signature = NodeCrypto.sign("sha256", Buffer.from(signingInput, "utf8"), {
    key: apns.privateKeyPem,
    dsaEncoding: "ieee-p1363",
  });
  const token = `${signingInput}.${signature.toString("base64url")}`;
  cachedApnsJwt = { token, expiresAtMs: nowMs + 45 * 60 * 1_000, cacheKey };
  return token;
}

async function sendApnsHttp2(input: {
  readonly apns: ApnsPushConfig;
  readonly token: string;
  readonly pushType: "alert" | "liveactivity";
  readonly topic: string;
  readonly sandbox: boolean;
  readonly payload: Record<string, unknown>;
}): Promise<{
  readonly ok: boolean;
  readonly status: number | null;
  readonly reason: string | null;
  readonly apnsId: string | null;
  readonly invalidToken: boolean;
}> {
  const authority = input.sandbox
    ? "https://api.sandbox.push.apple.com"
    : "https://api.push.apple.com";
  const jwt = getApnsProviderJwt(input.apns);
  const body = JSON.stringify(input.payload);

  return new Promise((resolve) => {
    let client: NodeHttp2.ClientHttp2Session | null = null;
    let settled = false;
    const finish = (result: {
      readonly ok: boolean;
      readonly status: number | null;
      readonly reason: string | null;
      readonly apnsId: string | null;
      readonly invalidToken: boolean;
    }) => {
      if (settled) return;
      settled = true;
      try {
        client?.close();
      } catch {
        // ignore close error
      }
      resolve(result);
    };

    try {
      client = NodeHttp2.connect(authority);
      client.setTimeout(10_000, () => {
        finish({
          ok: false,
          status: null,
          reason: "timeout",
          apnsId: null,
          invalidToken: false,
        });
      });
      client.once("error", (err) => {
        finish({
          ok: false,
          status: null,
          reason: err.message,
          apnsId: null,
          invalidToken: false,
        });
      });

      const req = client.request({
        ":method": "POST",
        ":path": `/3/device/${encodeURIComponent(input.token)}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": input.topic,
        "apns-push-type": input.pushType,
        "apns-priority": "10",
        "content-type": "application/json",
      });

      let status: number | null = null;
      let apnsId: string | null = null;
      const chunks: Array<Buffer> = [];
      req.on("response", (headers) => {
        const rawStatus = headers[":status"];
        status = typeof rawStatus === "number" ? rawStatus : Number(rawStatus ?? 0) || null;
        const rawId = headers["apns-id"];
        apnsId =
          typeof rawId === "string" ? rawId : Array.isArray(rawId) ? (rawId[0] ?? null) : null;
      });
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        let reason: string | null = null;
        if (chunks.length > 0) {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              reason?: string;
            };
            if (typeof parsed.reason === "string") reason = parsed.reason;
          } catch {
            // ignore non-JSON body
          }
        }
        const ok = status !== null && status >= 200 && status < 300;
        const invalidToken =
          status === 410 || reason === "BadDeviceToken" || reason === "Unregistered";
        finish({ ok, status, reason, apnsId, invalidToken });
      });
      req.on("error", (err) => {
        finish({
          ok: false,
          status: null,
          reason: err.message,
          apnsId: null,
          invalidToken: false,
        });
      });
      req.end(body);
    } catch (error) {
      finish({
        ok: false,
        status: null,
        reason: error instanceof Error ? error.message : String(error),
        apnsId: null,
        invalidToken: false,
      });
    }
  });
}

async function getFcmAccessToken(fcm: FcmPushConfig): Promise<string | null> {
  const nowMs = Date.now();
  const cacheKey = `${fcm.projectId}:${fcm.clientEmail}`;
  if (
    cachedFcmAccess &&
    cachedFcmAccess.cacheKey === cacheKey &&
    cachedFcmAccess.expiresAtMs > nowMs
  ) {
    return cachedFcmAccess.token;
  }
  const nowSec = Math.floor(nowMs / 1_000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" }), "utf8").toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: fcm.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: nowSec,
      exp: nowSec + 3600,
    }),
    "utf8",
  ).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = NodeCrypto.sign(
    "RSA-SHA256",
    Buffer.from(signingInput, "utf8"),
    fcm.privateKeyPem,
  );
  const assertion = `${signingInput}.${signature.toString("base64url")}`;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
  };
  if (typeof data.access_token !== "string" || !data.access_token) return null;
  const ttlMs = Math.max(60, Math.min(3000, Number(data.expires_in ?? 3000) - 300)) * 1_000;
  cachedFcmAccess = {
    token: data.access_token,
    expiresAtMs: nowMs + ttlMs,
    cacheKey,
  };
  return data.access_token;
}

async function sendFcmPush(input: {
  readonly fcm: FcmPushConfig;
  readonly token: string;
  readonly title: string;
  readonly body: string;
  readonly data: Record<string, string>;
}): Promise<{
  readonly ok: boolean;
  readonly status: number | null;
  readonly reason: string | null;
  readonly apnsId: string | null;
  readonly invalidToken: boolean;
}> {
  const accessToken = await getFcmAccessToken(input.fcm);
  if (!accessToken) {
    return {
      ok: false,
      status: null,
      reason: "fcm_oauth_failed",
      apnsId: null,
      invalidToken: false,
    };
  }
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(input.fcm.projectId)}/messages:send`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        message: {
          token: input.token,
          notification: { title: input.title, body: input.body },
          data: input.data,
        },
      }),
      signal: AbortSignal.timeout(10_000),
    },
  ).catch(() => null);
  if (!res) {
    return {
      ok: false,
      status: null,
      reason: "fcm_network_error",
      apnsId: null,
      invalidToken: false,
    };
  }
  const payload = (await res.json().catch(() => ({}))) as {
    name?: string;
    error?: { status?: string; message?: string };
  };
  const reason = payload.error?.status ?? payload.error?.message ?? null;
  const invalidToken = res.status === 404 || reason === "UNREGISTERED";
  return {
    ok: res.ok,
    status: res.status,
    reason,
    apnsId: typeof payload.name === "string" ? payload.name : null,
    invalidToken,
  };
}

async function sendExpoPush(input: {
  readonly token: string;
  readonly title: string;
  readonly body: string;
  readonly data: Record<string, string>;
}): Promise<{
  readonly ok: boolean;
  readonly status: number | null;
  readonly reason: string | null;
  readonly apnsId: string | null;
  readonly invalidToken: boolean;
}> {
  const res = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      to: input.token,
      title: input.title,
      body: input.body,
      sound: "default",
      data: input.data,
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res) {
    return {
      ok: false,
      status: null,
      reason: "expo_network_error",
      apnsId: null,
      invalidToken: false,
    };
  }
  const payload = (await res.json().catch(() => ({}))) as {
    data?: {
      status?: string;
      id?: string;
      message?: string;
      details?: { error?: string };
    };
  };
  const item = payload.data;
  const errCode = item?.details?.error ?? item?.message ?? null;
  const ok = res.ok && item?.status !== "error";
  return {
    ok,
    status: res.status,
    reason: ok ? null : errCode,
    apnsId: typeof item?.id === "string" ? item.id : null,
    invalidToken: item?.details?.error === "DeviceNotRegistered",
  };
}

export async function dispatchPushForActivity(input: {
  readonly config: ConnectConfig;
  readonly db: ConnectDatabase;
  readonly userId: string;
  readonly previousPhase: string | null;
  readonly state: {
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
  } | null;
  readonly aggregate: AgentActivityAggregateState | null;
}): Promise<ReadonlyArray<RelayDeliveryResult>> {
  const user = input.db.findUserById(input.userId);
  if (!user || user.disabledAt !== null || !user.permissions.mobilePush) {
    return [];
  }

  const results: Array<RelayDeliveryResult> = [];
  const devices = input.db.listFullDevicesForUser(input.userId);

  if (
    input.state !== null &&
    input.state.phase !== input.previousPhase &&
    ALERT_PHASES.has(input.state.phase)
  ) {
    const copy = formatAlertCopy(input.state);
    const data = {
      environmentId: input.state.environmentId,
      threadId: input.state.threadId,
      deepLink: input.state.deepLink,
      phase: input.state.phase,
    };

    for (const device of devices) {
      if (!device.pushToken || !shouldNotifyForPhase(input.state.phase, device.preferences)) {
        continue;
      }
      if (
        device.pushToken.startsWith("ExponentPushToken[") ||
        device.pushToken.startsWith("ExpoPushToken[")
      ) {
        const res = await sendExpoPush({
          token: device.pushToken,
          title: copy.title,
          body: copy.body,
          data,
        });
        if (res.invalidToken) input.db.clearDevicePushToken(input.userId, device.deviceId);
        results.push({
          deviceId: device.deviceId,
          kind: "push_notification",
          ok: res.ok,
          apnsStatus: res.status,
          apnsReason: res.reason,
          apnsId: res.apnsId,
        });
        continue;
      }

      if (device.platform === "ios" && input.config.apns) {
        const res = await sendApnsHttp2({
          apns: input.config.apns,
          token: device.pushToken,
          pushType: "alert",
          topic: device.bundleId || input.config.apns.bundleId,
          sandbox:
            device.apsEnvironment !== undefined && device.apsEnvironment !== null
              ? device.apsEnvironment === "sandbox"
              : input.config.apns.useSandbox,
          payload: {
            aps: {
              alert: copy,
              sound: "default",
            },
            ...data,
          },
        });
        if (res.invalidToken) input.db.clearDevicePushToken(input.userId, device.deviceId);
        results.push({
          deviceId: device.deviceId,
          kind: "push_notification",
          ok: res.ok,
          apnsStatus: res.status,
          apnsReason: res.reason,
          apnsId: res.apnsId,
        });
        continue;
      }

      if (device.platform === "android" && input.config.fcm) {
        const res = await sendFcmPush({
          fcm: input.config.fcm,
          token: device.pushToken,
          title: copy.title,
          body: copy.body,
          data,
        });
        if (res.invalidToken) input.db.clearDevicePushToken(input.userId, device.deviceId);
        results.push({
          deviceId: device.deviceId,
          kind: "push_notification",
          ok: res.ok,
          apnsStatus: res.status,
          apnsReason: res.reason,
          apnsId: res.apnsId,
        });
      }
    }
  }

  if (input.config.apns) {
    const deviceById = new Map(devices.map((d) => [d.deviceId, d]));
    const liveTokens = input.db.listLiveActivityTokensForUser(input.userId);
    const nowSec = Math.floor(Date.now() / 1_000);
    for (const tokenRow of liveTokens) {
      const device = deviceById.get(tokenRow.deviceId);
      if (device?.preferences?.liveActivitiesEnabled === false) continue;
      const bundleId = device?.bundleId || input.config.apns.bundleId;
      const kind = input.aggregate ? "live_activity_update" : "live_activity_end";
      const res = await sendApnsHttp2({
        apns: input.config.apns,
        token: tokenRow.activityPushToken,
        pushType: "liveactivity",
        topic: `${bundleId}.push-type.liveactivity`,
        sandbox:
          device?.apsEnvironment !== undefined && device?.apsEnvironment !== null
            ? device.apsEnvironment === "sandbox"
            : input.config.apns.useSandbox,
        payload: {
          aps: input.aggregate
            ? {
                timestamp: nowSec,
                event: "update",
                "content-state": input.aggregate,
              }
            : {
                timestamp: nowSec,
                event: "end",
                "dismissal-date": nowSec,
              },
        },
      });
      if (res.invalidToken) {
        input.db.deleteLiveActivityToken(input.userId, tokenRow.deviceId);
      }
      results.push({
        deviceId: tokenRow.deviceId,
        kind,
        ok: res.ok,
        apnsStatus: res.status,
        apnsReason: res.reason,
        apnsId: res.apnsId,
      });
    }
  }

  return results;
}
