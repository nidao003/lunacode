import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { parseGrokPlan, readGrokAccount } from "./usageLimits.ts";

describe("parseGrokPlan", () => {
  it("extracts display names and normalized subscription tiers from top-level or nested settings", () => {
    expect(parseGrokPlan({ subscription_tier_display: "SuperGrok" })).toBe("SuperGrok");
    expect(
      parseGrokPlan({
        settings: { subscription_tier_display: "SuperGrok Heavy", subscription_tier: "SUPERGROK" },
      }),
    ).toBe("SuperGrok Heavy");
    expect(parseGrokPlan({ settings: { subscription_tier: "SUPERGROK_HEAVY" } })).toBe(
      "SuperGrok Heavy",
    );
    expect(parseGrokPlan({ subscription_tier: "supergrok" })).toBe("SuperGrok");
    expect(parseGrokPlan({ subscription_tier: "team_plus" })).toBe("Team Plus");
    expect(parseGrokPlan({})).toBeUndefined();
    expect(parseGrokPlan(null)).toBeUndefined();
  });
});

describe("readGrokAccount", () => {
  const grokAuthJson = JSON.stringify({
    "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
      key: "grok-oauth-token",
      auth_mode: "oauth",
      email: "grok@example.com",
    },
  });

  const billingBody = {
    config: {
      creditUsagePercent: 25,
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_MONTHLY",
        end: "2026-12-01T00:00:00Z",
      },
    },
  };

  it.effect("reads both billing usage and subscription tier from /v1/settings", () =>
    readGrokAccount({
      GROK_HOME: "/nonexistent/grok-home",
      GROK_AUTH: grokAuthJson,
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(
                request.url.endsWith("/v1/settings")
                  ? { settings: { subscription_tier_display: "SuperGrok Heavy" } }
                  : billingBody,
              ),
            ),
          ),
        ),
      ),
      Effect.provide(NodeServices.layer),
      Effect.map((result) => {
        expect(result.email).toBe("grok@example.com");
        expect(result.planLabel).toBe("SuperGrok Heavy");
        expect(result.usageLimits.windows[0]?.usedPercent).toBe(25);
      }),
    ),
  );

  it.effect("keeps billing usage limits when /v1/settings fails", () =>
    readGrokAccount({
      GROK_HOME: "/nonexistent/grok-home",
      GROK_AUTH: grokAuthJson,
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              request.url.endsWith("/v1/settings")
                ? Response.json({ error: "unavailable" }, { status: 500 })
                : Response.json(billingBody),
            ),
          ),
        ),
      ),
      Effect.provide(NodeServices.layer),
      Effect.map((result) => {
        expect(result.email).toBe("grok@example.com");
        expect(result.planLabel).toBeUndefined();
        expect(result.usageLimits.windows[0]?.usedPercent).toBe(25);
      }),
    ),
  );
});
