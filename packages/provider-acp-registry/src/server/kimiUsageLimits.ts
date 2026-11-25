import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

// Kimi rotates the refresh token on every refresh and serializes that with `{home}/oauth/<name>.lock`;
// writes take the same lock, or Kimi's next turn presents a token the server already rotated.
const Credential = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  expires_at: Schema.optional(Schema.Number),
  expires_in: Schema.optional(Schema.Number),
  token_type: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
});
const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  token_type: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
});
const Identity = Schema.Struct({
  user_id: Schema.optional(Schema.String),
  nickname: Schema.optional(Schema.String),
  user_level_name: Schema.optional(Schema.String),
  level_name: Schema.optional(Schema.String),
  membership: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      level: Schema.optional(Schema.String),
    }),
  ),
});
const UsageWindow = Schema.Struct({
  window: Schema.optional(
    Schema.Struct({
      duration: Schema.optional(Schema.Number),
      timeUnit: Schema.optional(Schema.String),
    }),
  ),
  detail: Schema.optional(
    Schema.Struct({
      limit: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
      used: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
      remaining: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
      resetTime: Schema.optional(Schema.String),
    }),
  ),
});
const Usages = Schema.Struct({
  usage: Schema.optional(
    Schema.Struct({
      limit: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
      used: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
      remaining: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
      resetTime: Schema.optional(Schema.String),
    }),
  ),
  limits: Schema.optional(Schema.Array(UsageWindow)),
});

const decodeCredential = Schema.decodeUnknownEffect(Schema.fromJsonString(Credential));
const encodeCredential = Schema.encodeEffect(Schema.fromJsonString(Credential));

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const REFRESH_ENDPOINT = "https://auth.kimi.com/api/oauth/token";
const MAINLAND_API = "https://api.kimi.com/coding/v1";
const LOCK_STALE_MS = 5_000;
const LOCK_RETRY = "250 millis";
const LOCK_ATTEMPTS = 40;
const AUTH_TIMEOUT = "15 seconds";

/** Kimi's own rule: refresh once less than five minutes remain. */
const REFRESH_MARGIN_SECONDS = 300;
export const KIMI_QUOTA_CACHE_TTL_MS = 5 * 60_000;

interface CachedKimiProbe {
  readonly accessToken: string;
  readonly cachedAtMs: number;
  readonly result: KimiUsageLimitsProbe;
}

const kimiQuotaCache = new Map<string, CachedKimiProbe>();

export function clearKimiUsageLimitsCache(): void {
  kimiQuotaCache.clear();
}

const numberValue = (value: string | number | undefined): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const iso = (value: string | undefined): string | undefined => {
  const parsed = value ? DateTime.make(value) : Option.none();
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
};

const windowMins = (item: typeof UsageWindow.Type): number | undefined => {
  const duration = item.window?.duration;
  if (duration === undefined || !Number.isFinite(duration) || duration <= 0) return undefined;
  switch (item.window?.timeUnit) {
    case "TIME_UNIT_MINUTE":
      return duration;
    case "TIME_UNIT_HOUR":
      return duration * 60;
    case "TIME_UNIT_DAY":
      return duration * 24 * 60;
    default:
      return undefined;
  }
};

function usageWindow(
  id: string,
  label: string,
  kind: ServerProviderUsageWindow["kind"],
  detail: NonNullable<typeof UsageWindow.Type.detail>,
  windowDurationMins: number | undefined,
): ServerProviderUsageWindow | undefined {
  const limit = numberValue(detail.limit);
  const used = numberValue(detail.used);
  const remaining = numberValue(detail.remaining);
  // Prefer the server's own remaining count; fall back to limit - used.
  const left = remaining ?? (limit !== undefined && used !== undefined ? limit - used : undefined);
  const total = limit ?? (left !== undefined && used !== undefined ? left + used : undefined);
  if (left === undefined || total === undefined || total <= 0) return undefined;
  const resetsAt = iso(detail.resetTime);
  return {
    id,
    label,
    kind,
    usedPercent: Math.max(0, Math.min(100, (1 - left / total) * 100)),
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
  };
}

/** Map Kimi's `GET /usages` answer to windows; `limits[]` carries the 5-hour bucket, `usage` the weekly one. */
export function kimiUsagesWindows(response: typeof Usages.Type, checkedAt: string) {
  const windows = new Map<string, ServerProviderUsageWindow>();
  for (const item of response.limits ?? []) {
    if (!item.detail) continue;
    const mins = windowMins(item);
    const session = mins !== undefined && mins <= 24 * 60;
    const window = usageWindow(
      session ? "five_hour" : "limit",
      session ? "5-hour" : "Quota",
      session ? "session" : "other",
      item.detail,
      mins,
    );
    if (window) windows.set(window.id, window);
  }
  if (response.usage) {
    const window = usageWindow("weekly", "Weekly", "weekly", response.usage, 7 * 24 * 60);
    if (window) windows.set(window.id, window);
  }
  return windows.size > 0
    ? makeUsageLimits({ checkedAt, windows: windows.values() })
    : makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
}

const refreshLock = Effect.fn("kimiRefreshLock")(function* (
  lockPath: string,
  fs: FileSystem.FileSystem,
) {
  let attempts = 0;
  while (attempts < LOCK_ATTEMPTS) {
    const acquired = yield* fs.makeDirectory(lockPath, { recursive: false }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (acquired) return true;
    // A crashed writer leaves its directory behind; 5 seconds without a touch is stale.
    const now = yield* Clock.currentTimeMillis;
    const stale = yield* fs.stat(lockPath).pipe(
      Effect.map((info) =>
        Option.match(info.mtime, {
          onNone: () => true,
          onSome: (mtime) => now - mtime.getTime() > LOCK_STALE_MS,
        }),
      ),
      Effect.orElseSucceed(() => true),
    );
    if (stale) {
      yield* fs.remove(lockPath, { recursive: true }).pipe(Effect.ignore);
    }
    attempts += 1;
    yield* Effect.sleep(LOCK_RETRY);
  }
  return false;
});

const kimiHeaders = (deviceId: string | undefined) => ({
  Accept: "application/json",
  ...(deviceId ? { "X-Msh-Device-Id": deviceId } : {}),
  "X-Msh-Platform": "kimi_code_cli",
});

const readUsages = Effect.fn("readKimiUsages")(function* (
  accessToken: string,
  deviceId: string | undefined,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const client = yield* HttpClient.HttpClient;
  return yield* client
    .execute(
      HttpClientRequest.get(`${MAINLAND_API}/usages`).pipe(
        HttpClientRequest.bearerToken(accessToken),
        HttpClientRequest.setHeaders(kimiHeaders(deviceId)),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Usages)),
      Effect.map((body) => kimiUsagesWindows(body, checkedAt)),
      Effect.timeout(AUTH_TIMEOUT),
    );
});

interface KimiIdentity {
  readonly userId?: string;
  readonly nickname?: string;
  readonly plan?: string;
}

const readIdentity = Effect.fn("readKimiIdentity")(function* (
  accessToken: string,
  deviceId: string | undefined,
) {
  const client = yield* HttpClient.HttpClient;
  return yield* client
    .execute(
      HttpClientRequest.get(`${MAINLAND_API}/me`).pipe(
        HttpClientRequest.bearerToken(accessToken),
        HttpClientRequest.setHeaders(kimiHeaders(deviceId)),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Identity)),
      Effect.timeout(AUTH_TIMEOUT),
      Effect.map((identity): KimiIdentity => {
        const plan =
          identity.user_level_name?.trim() ||
          identity.level_name?.trim() ||
          identity.membership?.name?.trim() ||
          identity.membership?.level?.trim();
        return {
          ...(identity.user_id ? { userId: identity.user_id } : {}),
          ...(identity.nickname?.trim() ? { nickname: identity.nickname.trim() } : {}),
          ...(plan ? { plan } : {}),
        };
      }),
      Effect.orElseSucceed((): KimiIdentity => ({})),
    );
});

/**
 * A usable access token for the saved credential. On POSIX, refreshes through Kimi's OAuth
 * endpoint under Kimi's lock and writes the rotated credential back; on Windows (`win32`), never
 * refreshes or writes credentials back (matches cc-switch's `kimi_oauth` policy).
 */
const usableAccessToken = Effect.fn("usableKimiAccessToken")(function* (input: {
  readonly credentialPath: string;
  readonly home: string;
  readonly deviceId: string | undefined;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly client: HttpClient.HttpClient;
}) {
  const refresh = Effect.gen(function* () {
    const raw = yield* input.fs.readFileString(input.credentialPath);
    const credential = yield* decodeCredential(raw).pipe(Effect.orElseSucceed(() => undefined));
    if (!credential?.access_token) return { status: "missing" } as const;
    const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
    const expiresAt = credential.expires_at ?? 0;
    if (expiresAt > nowSeconds + REFRESH_MARGIN_SECONDS) {
      return { status: "ok", token: credential.access_token } as const;
    }
    if ((yield* HostProcess.Platform) === "win32") {
      if (expiresAt > nowSeconds) {
        return { status: "ok", token: credential.access_token } as const;
      }
      return credential.refresh_token
        ? ({ status: "expired" } as const)
        : ({ status: "missing" } as const);
    }
    if (!credential.refresh_token) return { status: "missing" } as const;

    const lockName = input.path.basename(input.credentialPath, ".json");
    const lockPath = input.path.join(input.home, "oauth", `${lockName}.lock`);
    yield* input.fs.makeDirectory(input.path.dirname(lockPath), {
      recursive: true,
    });
    const acquired = yield* refreshLock(lockPath, input.fs);
    if (!acquired) return { status: "ok", token: credential.access_token } as const;

    return yield* Effect.gen(function* () {
      // Re-read under the lock: Kimi may have rotated it while we waited.
      const current = yield* input.fs.readFileString(input.credentialPath).pipe(
        Effect.flatMap(decodeCredential),
        Effect.orElseSucceed(() => credential),
      );
      const currentExpiry = current.expires_at ?? 0;
      if (currentExpiry > nowSeconds + REFRESH_MARGIN_SECONDS && current.access_token) {
        return { status: "ok", token: current.access_token } as const;
      }
      const refreshed = yield* input.client
        .execute(
          HttpClientRequest.post(REFRESH_ENDPOINT).pipe(
            HttpClientRequest.setHeaders({
              Accept: "application/json",
              ...(input.deviceId ? { "X-Msh-Device-Id": input.deviceId } : {}),
              "X-Msh-Platform": "kimi_code_cli",
            }),
            HttpClientRequest.bodyUrlParams({
              client_id: CLIENT_ID,
              grant_type: "refresh_token",
              refresh_token: current.refresh_token ?? "",
            }),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(TokenResponse)),
          Effect.timeout(AUTH_TIMEOUT),
          Effect.orElseSucceed(() => undefined),
        );
      if (!refreshed) {
        return {
          status: "ok",
          token: current.access_token ?? credential.access_token ?? "",
        } as const;
      }
      const next = yield* encodeCredential({
        ...current,
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token ?? current.refresh_token,
        expires_at: nowSeconds + (refreshed.expires_in ?? 900),
        expires_in: refreshed.expires_in ?? current.expires_in ?? 900,
        token_type: refreshed.token_type ?? current.token_type ?? "Bearer",
        scope: refreshed.scope ?? current.scope ?? "",
      }).pipe(Effect.orElseSucceed(() => undefined));
      if (next) {
        yield* input.fs
          .writeFileString(input.credentialPath, next, { mode: 0o600 })
          .pipe(Effect.ignore({ log: true }));
      }
      return { status: "ok", token: refreshed.access_token } as const;
    }).pipe(Effect.ensuring(input.fs.remove(lockPath, { recursive: true }).pipe(Effect.ignore)));
  });

  return yield* refresh;
});

export interface KimiUsageLimitsProbe {
  readonly usageLimits: ServerProviderUsageLimits;
  readonly email?: string;
  readonly label?: string;
}

/**
 * Read Kimi Code's account and quota from the same home the ACP runtime uses.
 * `undefined` means this instance is not a Kimi Code sign-in, so no read is attempted.
 */
export const readKimiUsageLimits = Effect.fn("readKimiUsageLimits")(function* (input: {
  readonly configuredHome: string | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* HttpClient.HttpClient;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const home = input.configuredHome || path.join(yield* HostProcess.HomeDirectory, ".kimi-code");
  const credentialPath = path.join(home, "credentials", "kimi-code.json");
  if (!(yield* fs.exists(credentialPath).pipe(Effect.orElseSucceed(() => false)))) {
    kimiQuotaCache.delete(home);
    return undefined;
  }
  const deviceId = yield* fs.readFileString(path.join(home, "device_id")).pipe(
    Effect.map((text) => text.trim()),
    Effect.orElseSucceed(() => ""),
  );
  const tokenOutcome = yield* usableAccessToken({
    credentialPath,
    home,
    deviceId: deviceId || undefined,
    fs,
    path,
    client,
  });
  if (tokenOutcome.status === "missing") {
    kimiQuotaCache.delete(home);
    return {
      usageLimits: makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Sign in with Kimi Code to see its limits.",
      }),
    } satisfies KimiUsageLimitsProbe;
  }
  if (tokenOutcome.status === "expired") {
    kimiQuotaCache.delete(home);
    return {
      usageLimits: makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Use this account once in Kimi Code, then refresh.",
      }),
    } satisfies KimiUsageLimitsProbe;
  }
  const accessToken = tokenOutcome.token;
  const nowMs = yield* Clock.currentTimeMillis;
  const cached = kimiQuotaCache.get(home);
  if (
    cached &&
    cached.accessToken === accessToken &&
    nowMs >= cached.cachedAtMs &&
    nowMs - cached.cachedAtMs < KIMI_QUOTA_CACHE_TTL_MS
  ) {
    return cached.result;
  }
  const identity = yield* readIdentity(accessToken, deviceId || undefined);
  const usageLimits = yield* readUsages(accessToken, deviceId || undefined).pipe(
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Kimi Code did not return usage limits.",
      }),
    ),
  );
  const result: KimiUsageLimitsProbe = {
    usageLimits,
    // Kimi names an account by its nickname; the contract has no separate field for it, and the
    // cards label accounts by `auth.email`.
    ...((identity.nickname ?? identity.userId)
      ? { email: identity.nickname ?? identity.userId }
      : {}),
    ...(identity.plan ? { label: identity.plan } : {}),
  };
  if (!usageLimits.unavailable) {
    kimiQuotaCache.set(home, { accessToken, cachedAtMs: nowMs, result });
  }
  return result;
});
