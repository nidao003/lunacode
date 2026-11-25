import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient } from "effect/http";
import { describe, expect, it } from "vite-plus/test";

import * as ClaudeResetCredits from "./claudeResetCredits.ts";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const grant = (overrides: Record<string, unknown>) => ({
  id: "grant_a",
  resets_left: 1,
  usable_now: true,
  ...overrides,
});

const writeLogin = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped();
  yield* fs.writeFileString(
    path.join(directory, ".credentials.json"),
    '{"claudeAiOauth":{"accessToken":"oauth-token"}}',
  );
  const accountConfigPath = path.join(directory, ".claude.json");
  yield* fs.writeFileString(accountConfigPath, '{"oauthAccount":{"organizationUuid":"org-1"}}');
  return { configDir: directory, accountConfigPath };
});

const refuseRequests = HttpClient.make(() => Effect.die("must not send a request"));

describe("claudeResetCreditsToContract", () => {
  it("counts live grants and pins the next usable one", () => {
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract(
        {
          eligible: true,
          next_grant_id: "grant_a",
          grants: [
            grant({ resets_left: 2, ends_at: "2026-10-01T00:00:00Z" }),
            grant({ id: "paused", paused: true }),
            grant({ id: "expired", ends_at: "2026-09-01T00:00:00Z" }),
            grant({ id: "garbled", ends_at: "not a date" }),
            grant({ id: "date_only", ends_at: "2026-10-01" }),
            grant({ id: "impossible", ends_at: "2027-02-30T00:00:00Z" }),
            grant({ id: "empty", ends_at: "" }),
            grant({ id: "Not Valid" }),
            grant({ id: "grant_b", resets_left: 3, usable_now: false }),
          ],
        },
        NOW,
      ),
    ).toEqual({
      availableCount: 2,
      nextCreditId: "grant_a",
      nextExpiresAt: "2026-10-01T00:00:00.000Z",
      options: [
        expect.objectContaining({
          creditId: "grant_a",
          label: "Full reset",
          availableCount: 2,
          expiresAt: "2026-10-01T00:00:00.000Z",
        }),
      ],
    });
  });

  it("offers each kind of reset by its own grant", () => {
    const credits = ClaudeResetCredits.claudeResetCreditsToContract(
      {
        eligible: true,
        next_grant_id: "weekly_a",
        grants: [
          grant({ id: "weekly_a", clears: ["seven_day"], ends_at: "2026-12-10T22:00:00Z" }),
          grant({
            id: "fable_a",
            clears: ["seven_day_overage_included"],
            gives_back_weekly: true,
            ends_at: "2027-03-09T07:59:00Z",
          }),
          grant({ id: "fable_b", gives_back_weekly: true, type: "weekly" }),
          grant({ id: "session_a", type: "session" }),
          grant({ id: "spent", clears: ["seven_day"], resets_left: 0 }),
        ],
      },
      NOW,
    );
    expect(
      credits?.options?.map(({ creditId, label, availableCount }) => [
        creditId,
        label,
        availableCount,
      ]),
    ).toEqual([
      ["session_a", "5-hour reset", 1],
      ["weekly_a", "Weekly reset", 1],
      ["fable_a", "Fable reset", 2],
    ]);
    expect(credits).toMatchObject({ availableCount: 4, nextCreditId: "weekly_a" });
  });

  it("offers nothing to redeem without a usable next grant or an eligible account", () => {
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract(
        { eligible: true, next_grant_id: "grant_a", grants: [grant({ usable_now: false })] },
        NOW,
      ),
    ).toEqual({ availableCount: 0 });
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract({ eligible: true, grants: [grant({})] }, NOW),
    ).toEqual({
      availableCount: 0,
    });
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract(
        { eligible: false, grants: [grant({})] },
        NOW,
      ),
    ).toBeUndefined();
    expect(ClaudeResetCredits.claudeResetCreditsToContract(undefined, NOW)).toBeUndefined();
  });
});

effectIt.layer(NodeServices.layer)("readClaudeResetCredits", (it) => {
  it.effect("returns undefined without reading tokens or calling Anthropic endpoints", () =>
    Effect.gen(function* () {
      const { configDir } = yield* writeLogin;
      const credits = yield* ClaudeResetCredits.readClaudeResetCredits(configDir, "2.1.0").pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HttpClient.HttpClient, refuseRequests),
      );
      expect(credits).toBeUndefined();
    }),
  );
});

const consume = (client: HttpClient.HttpClient, ids = { grantId: "grant_a", requestId: "r-1" }) =>
  Effect.gen(function* () {
    const login = yield* writeLogin;
    return yield* ClaudeResetCredits.consumeClaudeResetCredit({
      ...login,
      version: "2.1.0",
      ...ids,
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.result,
    );
  });

effectIt.layer(NodeServices.layer)("consumeClaudeResetCredit", (it) => {
  it.effect("fails locally as signedOut for valid ids without sending requests", () =>
    Effect.gen(function* () {
      const result = yield* consume(refuseRequests);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ClaudeResetCreditError", reason: "signedOut" },
      });
      if (result._tag === "Failure") {
        expect(ClaudeResetCredits.isSettledClaudeResetCreditFailure(result.failure)).toBe(true);
      }
    }),
  );

  it.effect("refuses malformed ids without sending anything", () =>
    Effect.gen(function* () {
      for (const ids of [
        { grantId: "Bad Grant", requestId: "r-1" },
        { grantId: "grant_a", requestId: "has space" },
      ]) {
        const result = yield* consume(refuseRequests, ids);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ClaudeResetCreditError", reason: "malformedCredit" },
        });
        if (result._tag === "Failure") {
          expect(ClaudeResetCredits.isSettledClaudeResetCreditFailure(result.failure)).toBe(true);
        }
      }
    }),
  );
});
