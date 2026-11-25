import { ServerProviderUsageWindow, type ServerProviderUsageLimits } from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

// A failed probe drops its windows, so an expired sign-in after a restart would leave the account
// with nothing to show. cc-switch-style keep-last-good: persist each successful read per instance
// and serve it back, flagged as cached, only when the offline-readable account identity matches.
const CacheFile = Schema.Struct({
  version: Schema.Literal(1),
  account: Schema.Struct({
    /** sha256 of the normalized stored account email; the raw email never hits disk here. */
    emailHash: Schema.optional(Schema.String),
    /** The probe's credential fingerprint, kept for cross-instance account dedup. */
    fingerprint: Schema.optional(Schema.String),
    /** Last upstream subscription tier observed for the account. */
    plan: Schema.optional(Schema.String),
  }),
  limits: Schema.Struct({
    checkedAt: Schema.String,
    windows: Schema.Array(ServerProviderUsageWindow),
  }),
});
type CacheFile = typeof CacheFile.Type;

const cacheFileJson = Schema.fromJsonString(CacheFile);
const decodeCacheFileText = Schema.decodeEffect(cacheFileJson);
const encodeCacheFileText = Schema.encodeEffect(cacheFileJson);

const sha256Hex = Effect.fnUntraced(function* (text: string) {
  const digest = yield* Digest.Digest;
  return Hex.encode(yield* digest.digest(Digest.sha256, new TextEncoder().encode(text)));
});

const emailKey = (email: string | undefined) => {
  const normalized = email?.trim().toLowerCase();
  return normalized ? sha256Hex(`antigravity-email\0${normalized}`) : Effect.undefined;
};

export interface AntigravityQuotaCache {
  /** Best-effort write of a successful probe's windows; failures never surface to the probe. */
  readonly persist: (
    limits: ServerProviderUsageLimits,
    email: string | undefined,
    plan?: string,
  ) => Effect.Effect<void>;
  /**
   * On a failed probe, return the last good windows for the same stored account, keeping the
   * cached `checkedAt` and attaching the probe's `unavailable` marker. Any identity doubt
   * returns the probe result untouched.
   */
  readonly recover: (
    probed: ServerProviderUsageLimits,
    email: string | undefined,
  ) => Effect.Effect<ServerProviderUsageLimits>;
  /** Hydrates cached windows matching the current account email (or anonymous cache if omitted). */
  readonly hydrate: (email?: string) => Effect.Effect<ServerProviderUsageLimits | undefined>;
  /** Reads the cached subscription tier for the matching stored email when live probe is absent. */
  readonly readPlan: (email: string | undefined) => Effect.Effect<string | undefined>;
}

export const makeAntigravityQuotaCache = Effect.fn("makeAntigravityQuotaCache")(function* (input: {
  readonly stateDir: string;
  readonly instanceId: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const directory = path.join(input.stateDir, "lunacode", "agy-quota-cache");
  const cachePath = path.join(directory, `${yield* sha256Hex(input.instanceId)}.json`);

  const readCached = Effect.gen(function* () {
    if (!(yield* fs.exists(cachePath).pipe(Effect.orElseSucceed(() => false)))) return undefined;
    const text = yield* fs.readFileString(cachePath).pipe(Effect.orElseSucceed(() => undefined));
    if (text === undefined) return undefined;
    return yield* decodeCacheFileText(text).pipe(Effect.orElseSucceed(() => undefined));
  });

  const persist = Effect.fn("AntigravityQuotaCache.persist")(
    function* (limits: ServerProviderUsageLimits, email: string | undefined, plan?: string) {
      if (limits.unavailable !== undefined || limits.windows.length === 0) return;
      const hashed = yield* emailKey(email);
      const trimmedPlan = plan?.trim() || undefined;
      const file: CacheFile = {
        version: 1,
        account: {
          ...(hashed ? { emailHash: hashed } : {}),
          ...(limits.credentialFingerprint ? { fingerprint: limits.credentialFingerprint } : {}),
          ...(trimmedPlan ? { plan: trimmedPlan } : {}),
        },
        limits: { checkedAt: limits.checkedAt, windows: limits.windows },
      };
      yield* fs.makeDirectory(directory, { recursive: true });
      // Write-then-rename keeps readers on all-or-nothing content.
      const staging = `${cachePath}.tmp`;
      yield* fs.writeFileString(staging, yield* encodeCacheFileText(file));
      yield* fs.rename(staging, cachePath);
    },
    Effect.catch(() => Effect.logWarning("Could not persist the Antigravity quota cache.")),
  );

  const recover = Effect.fn("AntigravityQuotaCache.recover")(function* (
    probed: ServerProviderUsageLimits,
    email: string | undefined,
  ) {
    if (probed.unavailable?.reason !== "probeFailed" || probed.windows.length > 0) return probed;
    const hashed = yield* emailKey(email);
    const cached = yield* readCached;
    if (!cached) return probed;
    if (
      hashed === undefined
        ? cached.account.emailHash !== undefined
        : cached.account.emailHash !== hashed
    ) {
      return probed;
    }
    if (cached.limits.windows.length === 0) return probed;
    if (!Number.isFinite(Date.parse(cached.limits.checkedAt))) return probed;
    return {
      checkedAt: cached.limits.checkedAt,
      windows: cached.limits.windows,
      ...(cached.account.fingerprint ? { credentialFingerprint: cached.account.fingerprint } : {}),
      unavailable: probed.unavailable,
    };
  });

  const hydrate = Effect.fn("AntigravityQuotaCache.hydrate")(function* (email?: string) {
    const cached = yield* readCached;
    if (!cached) return undefined;
    const hashed = yield* emailKey(email);
    if (
      hashed === undefined
        ? cached.account.emailHash !== undefined
        : cached.account.emailHash !== hashed
    ) {
      return undefined;
    }
    if (cached.limits.windows.length === 0) return undefined;
    if (!Number.isFinite(Date.parse(cached.limits.checkedAt))) return undefined;
    return {
      checkedAt: cached.limits.checkedAt,
      windows: cached.limits.windows,
      ...(cached.account.fingerprint ? { credentialFingerprint: cached.account.fingerprint } : {}),
    } satisfies ServerProviderUsageLimits;
  });

  const clear = Effect.fn("AntigravityQuotaCache.clear")(function* () {
    yield* fs
      .remove(cachePath, { force: true })
      .pipe(Effect.catch(() => Effect.logWarning("Could not clear the Antigravity quota cache.")));
  });

  const readPlan = Effect.fn("AntigravityQuotaCache.readPlan")(function* (
    email: string | undefined,
  ) {
    const hashed = yield* emailKey(email);
    if (!hashed) return undefined;
    const cached = yield* readCached;
    if (!cached || cached.account.emailHash !== hashed) return undefined;
    return cached.account.plan?.trim() || undefined;
  });

  // Calls run inside the provider's probe fiber, outside this construction context, so bake the
  // construction-time services into every returned effect.
  const withServices = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Digest.Digest>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(Digest.Digest, digest),
    );

  return {
    persist: (limits: ServerProviderUsageLimits, email: string | undefined, plan?: string) =>
      withServices(persist(limits, email, plan)),
    recover: (probed: ServerProviderUsageLimits, email: string | undefined) =>
      withServices(recover(probed, email)),
    hydrate: (email?: string) => withServices(hydrate(email)),
    clear: () => withServices(clear()),
    readPlan: (email: string | undefined) => withServices(readPlan(email)),
  };
});
