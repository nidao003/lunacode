import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  KIMI_QUOTA_CACHE_TTL_MS,
  clearKimiUsageLimitsCache,
  kimiUsagesWindows,
  readKimiUsageLimits,
} from "./kimiUsageLimits.ts";

const decodeSavedCredential = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      access_token: Schema.String,
      refresh_token: Schema.String,
      expires_in: Schema.Number,
      scope: Schema.String,
    }),
  ),
);

const CHECKED_AT = "2026-11-22T14:00:00.000Z";
// Trimmed from Kimi Code 2.7.2's `GET /coding/v1/usages`; numbers are strings there.
const usages = {
  usage: {
    limit: "100",
    used: "16",
    remaining: "84",
    resetTime: "2026-11-23T15:31:54.446454Z",
  },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: {
        limit: "100",
        used: "5",
        remaining: "95",
        resetTime: "2026-11-22T15:31:54.446454Z",
      },
    },
  ],
};

it("maps Kimi's five-hour and weekly buckets to quota windows", () => {
  const limits = kimiUsagesWindows(usages, CHECKED_AT);
  assert.deepStrictEqual(limits.unavailable, undefined);
  const byId = new Map(
    limits.windows.map((window) => [
      window.id,
      { ...window, usedPercent: Math.round(window.usedPercent) },
    ]),
  );
  assert.deepStrictEqual(byId.get("five_hour"), {
    id: "five_hour",
    label: "5-hour",
    kind: "session",
    usedPercent: 5,
    resetsAt: "2026-11-22T15:31:54.446Z",
    windowDurationMins: 300,
  });
  assert.deepStrictEqual(byId.get("weekly"), {
    id: "weekly",
    label: "Weekly",
    kind: "weekly",
    usedPercent: 16,
    resetsAt: "2026-11-23T15:31:54.446Z",
    windowDurationMins: 10080,
  });
});

it("reports no limits rather than inventing one when Kimi sends nothing usable", () => {
  assert.strictEqual(kimiUsagesWindows({}, CHECKED_AT).unavailable?.reason, "unsupported");
  // A missing reset stays missing; only the percentage is reported.
  const limits = kimiUsagesWindows({ usage: { limit: 100, remaining: 40 } }, CHECKED_AT);
  assert.deepStrictEqual(limits.windows, [
    {
      id: "weekly",
      label: "Weekly",
      kind: "weekly",
      usedPercent: 60,
      windowDurationMins: 10080,
    },
  ]);
});

const writeHome = (home: string, credential: unknown) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.join(home, "credentials"), {
      recursive: true,
    });
    yield* fs.writeFileString(
      path.join(home, "credentials", "kimi-code.json"),
      JSON.stringify(credential),
    );
    yield* fs.writeFileString(path.join(home, "device_id"), "device-1");
  });

it.live("reads the account and quota from a still-valid Kimi sign-in", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kimi-" });
    const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
    yield* writeHome(home, {
      access_token: "valid-access",
      refresh_token: "refresh",
      expires_at: nowSeconds + 3_600,
      expires_in: 900,
    });
    const requests: Array<string> = [];
    const probe = yield* readKimiUsageLimits({ configuredHome: home }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push(request.url);
          assert.strictEqual(request.headers.authorization, "Bearer valid-access");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(
                request.url.endsWith("/usages")
                  ? usages
                  : {
                      user_id: "cnva68ecp7f4sms050t0",
                      nickname: "daodao",
                      user_level_name: "Allegretto",
                    },
              ),
            ),
          );
        }),
      ),
    );
    assert.deepStrictEqual(requests.toSorted(), [
      "https://api.kimi.com/coding/v1/me",
      "https://api.kimi.com/coding/v1/usages",
    ]);
    assert.strictEqual(probe?.email, "daodao");
    assert.strictEqual(probe?.label, "Allegretto");
    assert.strictEqual(probe?.usageLimits.windows.length, 2);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.live("ignores a home without a Kimi credential", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kimi-" });
    const probe = yield* readKimiUsageLimits({ configuredHome: home }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("no request")),
      ),
    );
    assert.strictEqual(probe, undefined);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.live("refreshes an expired access token and writes the rotated credential back", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kimi-" });
    yield* writeHome(home, {
      access_token: "stale-access",
      refresh_token: "old-refresh",
      expires_at: Math.floor((yield* Clock.currentTimeMillis) / 1_000) - 60,
      expires_in: 900,
      scope: "kimi-code",
    });
    const requests: Array<string> = [];
    const probe = yield* readKimiUsageLimits({ configuredHome: home }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push(request.url);
          if (request.url.endsWith("/api/oauth/token")) {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  access_token: "fresh-access",
                  refresh_token: "new-refresh",
                  expires_in: 900,
                  token_type: "Bearer",
                }),
              ),
            );
          }
          assert.strictEqual(request.headers.authorization, "Bearer fresh-access");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(request.url.endsWith("/usages") ? usages : {}),
            ),
          );
        }),
      ),
    );
    assert.deepStrictEqual(requests[0], "https://auth.kimi.com/api/oauth/token");
    assert.strictEqual(probe?.usageLimits.windows.length, 2);
    const saved = yield* fs.readFileString(path.join(home, "credentials", "kimi-code.json"));
    const decoded = yield* decodeSavedCredential(saved);
    assert.strictEqual(decoded.access_token, "fresh-access");
    assert.strictEqual(decoded.refresh_token, "new-refresh");
    assert.strictEqual(decoded.scope, "kimi-code");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.live("extracts Kimi subscription tier from fallback /me identity fields", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kimi-" });
    yield* writeHome(home, {
      access_token: "fresh-access",
      refresh_token: "refresh",
      expires_at: Math.floor((yield* Clock.currentTimeMillis) / 1_000) + 900,
      expires_in: 900,
      scope: "kimi-code",
    });
    const probe = yield* readKimiUsageLimits({ configuredHome: home }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(
                request.url.endsWith("/usages")
                  ? usages
                  : {
                      user_id: "u-1",
                      membership: { name: "Kimi Allegretto" },
                    },
              ),
            ),
          ),
        ),
      ),
    );
    assert.strictEqual(probe?.label, "Kimi Allegretto");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("caches Kimi usage limits for 5 minutes and skips refresh on Windows", () =>
  Effect.gen(function* () {
    clearKimiUsageLimitsCache();
    yield* TestClock.setTime(1_760_000_000_000);
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kimi-cache-" });
    const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
    yield* writeHome(home, {
      access_token: "cached-access",
      refresh_token: "refresh",
      expires_at: nowSeconds + 3_600,
      expires_in: 900,
      scope: "kimi-code",
    });

    const requests: Array<string> = [];
    const client = HttpClient.make((request) => {
      requests.push(request.url);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(
            request.url.endsWith("/usages")
              ? usages
              : { user_id: "u-1", nickname: "CachedUser", user_level_name: "Allegretto" },
          ),
        ),
      );
    });

    const first = yield* readKimiUsageLimits({ configuredHome: home }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HttpClient.HttpClient, client),
    );
    assert.strictEqual(requests.length, 2);
    assert.strictEqual(first?.email, "CachedUser");

    yield* TestClock.adjust("2 minutes");
    const second = yield* readKimiUsageLimits({ configuredHome: home }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HttpClient.HttpClient, client),
    );
    assert.strictEqual(requests.length, 2);
    assert.deepStrictEqual(second, first);

    yield* TestClock.adjust(`${KIMI_QUOTA_CACHE_TTL_MS} millis`);
    yield* readKimiUsageLimits({ configuredHome: home }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HttpClient.HttpClient, client),
    );
    assert.strictEqual(requests.length, 4);

    // Windows never refreshes an expired token or writes credentials back.
    const expiredHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kimi-win-" });
    const winNowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
    yield* writeHome(expiredHome, {
      access_token: "expired-access",
      refresh_token: "win-refresh",
      expires_at: winNowSeconds - 60,
      expires_in: 900,
      scope: "kimi-code",
    });
    const winRequests: Array<string> = [];
    const winResult = yield* readKimiUsageLimits({ configuredHome: expiredHome }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          winRequests.push(request.url);
          return Effect.die("Windows must not call refresh or usage endpoints on expired tokens");
        }),
      ),
    );
    assert.deepStrictEqual(winRequests, []);
    assert.strictEqual(winResult?.usageLimits.unavailable?.reason, "probeFailed");
    assert.strictEqual(
      winResult?.usageLimits.unavailable?.message,
      "Use this account once in Kimi Code, then refresh.",
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.live("adopts a credential another process rotated when the refresh answers 401", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kimi-adopt-" });
    yield* writeHome(home, {
      access_token: "stale-access",
      refresh_token: "old-refresh",
      expires_at: Math.floor((yield* Clock.currentTimeMillis) / 1_000) - 60,
      expires_in: 900,
      scope: "kimi-code",
    });
    const requests: Array<string> = [];
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        requests.push(request.url);
        if (request.url === "https://auth.kimi.com/api/oauth/token") {
          // While our refresh is in flight, another process wins the rotation and writes first.
          yield* writeHome(home, {
            access_token: "rotated-access",
            refresh_token: "new-refresh",
            expires_at: Math.floor((yield* Clock.currentTimeMillis) / 1_000) + 3_600,
            expires_in: 900,
            scope: "kimi-code",
          });
          return yield* Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 }),
            ),
          );
        }
        assert.strictEqual(request.headers.authorization, "Bearer rotated-access");
        return yield* Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              request.url.endsWith("/usages")
                ? usages
                : { user_id: "u-1", nickname: "AdoptedUser", user_level_name: "Allegretto" },
            ),
          ),
        );
      }),
    );
    const probe = yield* readKimiUsageLimits({ configuredHome: home }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HttpClient.HttpClient, client),
    );
    assert.deepStrictEqual(requests[0], "https://auth.kimi.com/api/oauth/token");
    assert.strictEqual(probe?.email, "AdoptedUser");
    // The winner's credential stays on disk; only a loser with no winner writes a tombstone.
    const saved = yield* fs.readFileString(path.join(home, "credentials", "kimi-code.json"));
    const decoded = yield* decodeSavedCredential(saved);
    assert.strictEqual(decoded.access_token, "rotated-access");
    assert.strictEqual(decoded.refresh_token, "new-refresh");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.live("writes Kimi's tombstone when the refresh is revoked and nobody rotated", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kimi-tombstone-" });
    yield* writeHome(home, {
      access_token: "revoked-access",
      refresh_token: "revoked-refresh",
      expires_at: Math.floor((yield* Clock.currentTimeMillis) / 1_000) - 60,
      expires_in: 900,
      scope: "kimi-code",
    });
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 }),
        ),
      ),
    );
    const probe = yield* readKimiUsageLimits({ configuredHome: home }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HttpClient.HttpClient, client),
    );
    assert.strictEqual(probe?.usageLimits.unavailable?.reason, "unsupported");
    const saved = yield* fs.readFileString(path.join(home, "credentials", "kimi-code.json"));
    const decoded = yield* decodeSavedCredential(saved);
    assert.strictEqual(decoded.access_token, "");
    assert.strictEqual(decoded.refresh_token, "");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.live("keeps the current token on a transient refresh failure", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kimi-transient-" });
    yield* writeHome(home, {
      access_token: "stale-access",
      refresh_token: "old-refresh",
      expires_at: Math.floor((yield* Clock.currentTimeMillis) / 1_000) - 60,
      expires_in: 900,
      scope: "kimi-code",
    });
    const requests: Array<string> = [];
    const client = HttpClient.make((request) => {
      requests.push(request.url);
      if (request.url === "https://auth.kimi.com/api/oauth/token") {
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("server error", { status: 500 })),
        );
      }
      assert.strictEqual(request.headers.authorization, "Bearer stale-access");
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(
            request.url.endsWith("/usages")
              ? usages
              : { user_id: "u-1", nickname: "StaleUser", user_level_name: "Allegretto" },
          ),
        ),
      );
    });
    const probe = yield* readKimiUsageLimits({ configuredHome: home }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HttpClient.HttpClient, client),
    );
    assert.deepStrictEqual(requests[0], "https://auth.kimi.com/api/oauth/token");
    assert.strictEqual(probe?.email, "StaleUser");
    const saved = yield* fs.readFileString(path.join(home, "credentials", "kimi-code.json"));
    const decoded = yield* decodeSavedCredential(saved);
    assert.strictEqual(decoded.access_token, "stale-access");
    assert.strictEqual(decoded.refresh_token, "old-refresh");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.live("refreshes only inside Kimi's half-lifetime window", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kimi-threshold-" });
    const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
    yield* writeHome(home, {
      access_token: "long-lived-access",
      refresh_token: "long-lived-refresh",
      expires_at: nowSeconds + 3_700,
      expires_in: 7_200,
      scope: "kimi-code",
    });
    const requests: Array<string> = [];
    const client = HttpClient.make((request) => {
      requests.push(request.url);
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response("server error", { status: 500 })),
      );
    });
    // 3700 of 7200 seconds remain; the threshold is max(300, 3600), so no refresh happens.
    const first = yield* readKimiUsageLimits({ configuredHome: home }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HttpClient.HttpClient, client),
    );
    assert.strictEqual(first?.usageLimits.unavailable?.reason, "probeFailed");
    assert.deepStrictEqual(requests, [
      "https://api.kimi.com/coding/v1/me",
      "https://api.kimi.com/coding/v1/usages",
    ]);

    // 3500 of 7200 seconds remain, inside the half-lifetime window: refresh once.
    yield* writeHome(home, {
      access_token: "long-lived-access",
      refresh_token: "long-lived-refresh",
      expires_at: nowSeconds + 3_500,
      expires_in: 7_200,
      scope: "kimi-code",
    });
    const refreshable = yield* readKimiUsageLimits({ configuredHome: home }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push(request.url);
          if (request.url === "https://auth.kimi.com/api/oauth/token") {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  access_token: "long-lived-access",
                  refresh_token: "long-lived-refresh",
                  expires_in: 7_200,
                  token_type: "Bearer",
                }),
              ),
            );
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(
                request.url.endsWith("/usages")
                  ? usages
                  : { user_id: "u-1", nickname: "ThresholdUser", user_level_name: "Allegretto" },
              ),
            ),
          );
        }),
      ),
    );
    assert.ok(requests.includes("https://auth.kimi.com/api/oauth/token"));
    assert.strictEqual(refreshable?.email, "ThresholdUser");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
