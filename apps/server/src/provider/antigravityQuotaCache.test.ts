import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";

import { makeAntigravityQuotaCache } from "./antigravityQuotaCache.ts";

const layer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

const goodLimits: ServerProviderUsageLimits = {
  checkedAt: "2026-11-20T12:00:00.000Z",
  windows: [
    {
      id: "gemini-weekly",
      kind: "weekly",
      label: "Gemini · Weekly",
      usedPercent: 42,
      resetsAt: "2026-11-23T00:00:00.000Z",
      windowDurationMins: 10080,
    },
  ],
  credentialFingerprint: "fp-1",
};

const failedLimits: ServerProviderUsageLimits = {
  checkedAt: "2026-11-22T12:00:00.000Z",
  windows: [],
  unavailable: { reason: "probeFailed", message: "sign-in expired" },
};

describe("makeAntigravityQuotaCache", () => {
  it.effect("serves last good windows for the same stored account after a failed probe", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({
        prefix: "agy-quota-cache-test-",
      });
      const cache = yield* makeAntigravityQuotaCache({
        stateDir,
        instanceId: "instance-1",
      });
      yield* cache.persist(goodLimits, "User@Example.com");
      const recovered = yield* cache.recover(failedLimits, "user@example.com");
      expect(recovered.windows).toEqual(goodLimits.windows);
      expect(recovered.checkedAt).toBe(goodLimits.checkedAt);
      expect(recovered.credentialFingerprint).toBe("fp-1");
      expect(recovered.unavailable).toEqual(failedLimits.unavailable);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("reads the cache written by a previous instance (restart simulation)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({
        prefix: "agy-quota-cache-test-",
      });
      const first = yield* makeAntigravityQuotaCache({
        stateDir,
        instanceId: "instance-1",
      });
      yield* first.persist(goodLimits, "user@example.com");
      const restarted = yield* makeAntigravityQuotaCache({
        stateDir,
        instanceId: "instance-1",
      });
      const recovered = yield* restarted.recover(failedLimits, "user@example.com");
      expect(recovered.windows).toEqual(goodLimits.windows);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("refuses to serve the cache to a different stored account", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({
        prefix: "agy-quota-cache-test-",
      });
      const cache = yield* makeAntigravityQuotaCache({
        stateDir,
        instanceId: "instance-1",
      });
      yield* cache.persist(goodLimits, "first@example.com");
      const recovered = yield* cache.recover(failedLimits, "second@example.com");
      expect(recovered).toEqual(failedLimits);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("refuses to serve the cache when the current account is unknown", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({
        prefix: "agy-quota-cache-test-",
      });
      const cache = yield* makeAntigravityQuotaCache({
        stateDir,
        instanceId: "instance-1",
      });
      yield* cache.persist(goodLimits, "user@example.com");
      expect(yield* cache.recover(failedLimits, undefined)).toEqual(failedLimits);
      expect(yield* cache.recover(failedLimits, "user@example.com")).not.toEqual(failedLimits);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("keeps the probe result when it carries windows or a non-probe failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({
        prefix: "agy-quota-cache-test-",
      });
      const cache = yield* makeAntigravityQuotaCache({
        stateDir,
        instanceId: "instance-1",
      });
      yield* cache.persist(goodLimits, "user@example.com");
      const withWindows: ServerProviderUsageLimits = {
        ...failedLimits,
        windows: goodLimits.windows,
      };
      expect(yield* cache.recover(withWindows, "user@example.com")).toEqual(withWindows);
      const unsupported: ServerProviderUsageLimits = {
        checkedAt: failedLimits.checkedAt,
        windows: [],
        unavailable: { reason: "unsupported" },
      };
      expect(yield* cache.recover(unsupported, "user@example.com")).toEqual(unsupported);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("returns the probe result untouched without a readable cache file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({
        prefix: "agy-quota-cache-test-",
      });
      const cache = yield* makeAntigravityQuotaCache({
        stateDir,
        instanceId: "instance-1",
      });
      expect(yield* cache.recover(failedLimits, "user@example.com")).toEqual(failedLimits);
      const digest = yield* Digest.Digest;
      const key = Hex.encode(
        yield* digest.digest(Digest.sha256, new TextEncoder().encode("instance-1")),
      );
      const corruptDir = yield* fs.makeTempDirectoryScoped({
        prefix: "agy-quota-cache-test-",
      });
      const corrupt = yield* makeAntigravityQuotaCache({
        stateDir: corruptDir,
        instanceId: "instance-1",
      });
      yield* fs.makeDirectory(`${corruptDir}/lunacode/agy-quota-cache`, {
        recursive: true,
      });
      yield* fs.writeFileString(`${corruptDir}/lunacode/agy-quota-cache/${key}.json`, "not json{");
      expect(yield* corrupt.recover(failedLimits, "user@example.com")).toEqual(failedLimits);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("does not persist failed or empty probes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({
        prefix: "agy-quota-cache-test-",
      });
      const cache = yield* makeAntigravityQuotaCache({
        stateDir,
        instanceId: "instance-1",
      });
      yield* cache.persist(failedLimits, "user@example.com");
      yield* cache.persist({ checkedAt: goodLimits.checkedAt, windows: [] }, "user@example.com");
      expect(yield* cache.recover(failedLimits, "user@example.com")).toEqual(failedLimits);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("scopes the cache per instance", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({
        prefix: "agy-quota-cache-test-",
      });
      const first = yield* makeAntigravityQuotaCache({
        stateDir,
        instanceId: "instance-1",
      });
      yield* first.persist(goodLimits, "user@example.com");
      const other = yield* makeAntigravityQuotaCache({
        stateDir,
        instanceId: "instance-2",
      });
      expect(yield* other.recover(failedLimits, "user@example.com")).toEqual(failedLimits);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("persists and recovers the cached subscription tier only for the matching email", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({
        prefix: "agy-quota-cache-test-",
      });
      const cache = yield* makeAntigravityQuotaCache({
        stateDir,
        instanceId: "instance-1",
      });
      yield* cache.persist(goodLimits, "User@Example.com", "AI Pro");
      expect(yield* cache.readPlan("user@example.com")).toBe("AI Pro");
      expect(yield* cache.readPlan("other@example.com")).toBeUndefined();
      expect(yield* cache.readPlan(undefined)).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "hydrates, recovers, and clears cached limits matching the normalized email or undefined",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped({
          prefix: "agy-quota-cache-test-",
        });
        const cache = yield* makeAntigravityQuotaCache({
          stateDir,
          instanceId: "instance-instance-level",
        });
        expect(yield* cache.hydrate()).toBeUndefined();

        yield* cache.persist(goodLimits, undefined);
        expect(yield* cache.hydrate()).toEqual(goodLimits);
        expect(yield* cache.hydrate("user@example.com")).toBeUndefined();
        expect(yield* cache.recover(failedLimits, undefined)).toEqual({
          ...goodLimits,
          unavailable: failedLimits.unavailable,
        });
        expect(yield* cache.recover(failedLimits, "user@example.com")).toEqual(failedLimits);

        yield* cache.clear();
        expect(yield* cache.hydrate()).toBeUndefined();
        expect(yield* cache.recover(failedLimits, undefined)).toEqual(failedLimits);

        // Email-keyed entries hydrate only when the matching normalized email is supplied.
        yield* cache.persist(goodLimits, "User@Example.com");
        expect(yield* cache.hydrate()).toBeUndefined();
        expect(yield* cache.hydrate("other@example.com")).toBeUndefined();
        expect(yield* cache.hydrate("user@example.com")).toEqual(goodLimits);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
