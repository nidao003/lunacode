import { type MintKeyPair, nowEpochSeconds, randomUuid, signEdDsaJwt } from "./crypto.ts";
import type { ConnectDatabase, EnvironmentRow } from "./db.ts";
import type { TunnelHub } from "./tunnelHub.ts";

export const RELAY_HOOK_DELIVERY_TYP = "t3-relay-hook-delivery+jwt";
export const RELAY_HOOK_DELIVERY_HEADER = "x-t3-relay-delivery";
export const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
export const HELD_WEBHOOK_TTL_MS = 24 * 60 * 60 * 1_000;

const STRIPPED_CALLER_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "cookie",
  "content-length",
]);

const replayingEnvironments = new Set<string>();

export function sanitizeWebhookForwardHeaders(
  incoming: Record<string, string | Array<string> | undefined>,
): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(incoming)) {
    if (rawValue === undefined) continue;
    const lower = key.toLowerCase();
    if (STRIPPED_CALLER_HEADERS.has(lower) || lower.startsWith("x-t3-relay-")) {
      continue;
    }
    const strValue = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
    if (strValue !== undefined) {
      cleaned[lower] = strValue;
    }
  }
  return cleaned;
}

export async function deliverWebhookToEnvironment(input: {
  readonly env: EnvironmentRow;
  readonly tunnelHub: TunnelHub;
  readonly mintKeys: MintKeyPair;
  readonly issuer: string;
  readonly deliveryId: string;
  readonly receivedAt: string;
  readonly hookId: string;
  readonly token: string;
  readonly method: string;
  readonly queryString: string;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}) {
  if (!input.env.tunnelId || !input.tunnelHub.hasActiveTunnel(input.env.tunnelId)) {
    return {
      ok: false as const,
      failure: "tunnel_down" as const,
      error: "Environment tunnel is offline.",
    };
  }

  const nowSec = nowEpochSeconds();
  const deliveryJwt = signEdDsaJwt({
    privateKeyPem: input.mintKeys.privateKeyPem,
    typ: RELAY_HOOK_DELIVERY_TYP,
    kid: input.mintKeys.kid,
    payload: {
      iss: input.issuer,
      aud: `t3-env:${input.env.environmentId}`,
      sub: input.env.environmentId,
      jti: randomUuid(),
      iat: nowSec,
      exp: nowSec + 25 * 3600,
      environmentId: input.env.environmentId,
      deliveryId: input.deliveryId,
      receivedAt: input.receivedAt,
      hookId: input.hookId,
    },
  });

  const targetHost = new URL(input.env.httpBaseUrl).host;
  const targetPath = `/api/hooks/${encodeURIComponent(input.hookId)}/${encodeURIComponent(input.token)}${input.queryString ? `?${input.queryString}` : ""}`;

  return input.tunnelHub.dispatchInternalRaw(input.env.tunnelId, {
    method: input.method,
    path: targetPath,
    headers: {
      ...input.headers,
      host: targetHost,
      [RELAY_HOOK_DELIVERY_HEADER]: deliveryJwt,
      "x-t3-relay-delivery-id": input.deliveryId,
      "x-t3-relay-received-at": input.receivedAt,
    },
    body: input.body,
    timeoutMs: 25_000,
  });
}

export async function replayHeldWebhooksForEnvironment(input: {
  readonly env: EnvironmentRow;
  readonly db: ConnectDatabase;
  readonly tunnelHub: TunnelHub;
  readonly mintKeys: MintKeyPair;
  readonly issuer: string;
}): Promise<{ readonly delivered: number; readonly pending: boolean }> {
  const { env, db, tunnelHub, mintKeys, issuer } = input;
  db.pruneExpiredHeldWebhooks();
  const initialRows = db.listHeldWebhooksForEnvironment(env.environmentId);
  if (initialRows.length === 0) {
    return { delivered: 0, pending: false };
  }
  if (!env.tunnelId || !tunnelHub.hasActiveTunnel(env.tunnelId)) {
    return { delivered: 0, pending: true };
  }
  const owner = db.findUserById(env.userId);
  if (!owner || owner.disabledAt !== null || !owner.permissions.webhooks) {
    return { delivered: 0, pending: true };
  }

  const lockKey = `${env.userId}:${env.environmentId}`;
  if (replayingEnvironments.has(lockKey)) {
    return { delivered: 0, pending: true };
  }
  replayingEnvironments.add(lockKey);

  let delivered = 0;
  try {
    const rows = db.listHeldWebhooksForEnvironment(env.environmentId);
    for (const row of rows) {
      if (!env.tunnelId || !tunnelHub.hasActiveTunnel(env.tunnelId)) {
        break;
      }
      const res = await deliverWebhookToEnvironment({
        env,
        tunnelHub,
        mintKeys,
        issuer,
        deliveryId: row.deliveryId,
        receivedAt: row.receivedAt,
        hookId: row.hookId,
        token: row.token,
        method: row.method,
        queryString: row.queryString,
        headers: row.headers,
        body: Buffer.from(row.bodyBase64, "base64"),
      });

      if (res.ok && res.status < 500) {
        db.deleteHeldWebhook(row.deliveryId);
        delivered += 1;
      } else {
        db.incrementHeldWebhookAttempt(row.deliveryId, 10);
        if (!res.ok && res.failure === "tunnel_down") {
          break;
        }
      }
    }
  } finally {
    replayingEnvironments.delete(lockKey);
  }

  const remaining = db.listHeldWebhooksForEnvironment(env.environmentId);
  return { delivered, pending: remaining.length > 0 };
}
