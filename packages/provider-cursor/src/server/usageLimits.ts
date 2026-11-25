import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import type { CursorSettings } from "../settings.ts";
import { CURSOR_USAGE_WINDOWS } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import { DEFAULT_CURSOR_API_ENDPOINT, exchangeCursorApiKey } from "./apiKey.ts";

const CursorUsageResponse = Schema.Struct({
  billingCycleStart: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  billingCycleEnd: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  planName: Schema.optional(Schema.String),
  membershipType: Schema.optional(Schema.String),
  individualMembershipType: Schema.optional(Schema.String),
  planUsage: Schema.optional(
    Schema.Struct({
      totalPercentUsed: Schema.optional(Schema.Number),
      autoPercentUsed: Schema.optional(Schema.Number),
      apiPercentUsed: Schema.optional(Schema.Number),
    }),
  ),
});

function cursorMembershipWords(raw: string): string {
  return raw
    .trim()
    .split(/[\s_-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

export function cursorPlanLabel(
  response: Pick<
    typeof CursorUsageResponse.Type,
    "planName" | "individualMembershipType" | "membershipType"
  >,
): string | undefined {
  const planName = response.planName?.trim();
  if (planName) {
    return /^cursor\b/i.test(planName) ? planName : `Cursor ${planName}`;
  }
  const membership = (response.individualMembershipType ?? response.membershipType)?.trim();
  if (!membership) return undefined;
  const normalized = membership.toLowerCase().replace(/[\s-]+/g, "_");
  switch (normalized) {
    case "free":
    case "hobby":
      return "Cursor Free";
    case "pro":
      return "Cursor Pro";
    case "pro_plus":
      return "Cursor Pro+";
    case "ultra":
    case "unified_ultra":
      return "Cursor Ultra";
    case "team":
    case "business":
      return "Cursor Teams";
    case "enterprise":
      return "Cursor Enterprise";
    default:
      return `Cursor ${cursorMembershipWords(membership)}`;
  }
}

/** Cursor's dashboard percentages include bonus usage; spend / limit does not. */
export function cursorUsageResponseToLimits(
  response: typeof CursorUsageResponse.Type,
  checkedAt: string,
) {
  const reset = DateTime.make(Number(response.billingCycleEnd));
  const resetsAt =
    Number(response.billingCycleEnd) > 0 && Option.isSome(reset)
      ? DateTime.formatIso(reset.value)
      : undefined;
  const cycleStart = Number(response.billingCycleStart);
  const windowDurationMins =
    resetsAt && cycleStart > 0
      ? Math.round((Number(response.billingCycleEnd) - cycleStart) / 60_000)
      : 0;
  const windows: ServerProviderUsageWindow[] = [];
  if (response.planUsage) {
    for (const { id, label } of CURSOR_USAGE_WINDOWS) {
      const usedPercent = response.planUsage[id];
      if (usedPercent === undefined || !Number.isFinite(usedPercent)) continue;
      windows.push({
        id,
        kind: "monthly",
        label,
        usedPercent: clampPercent(usedPercent),
        ...(resetsAt ? { resetsAt } : {}),
        ...(windowDurationMins > 0 ? { windowDurationMins } : {}),
      });
    }
  }
  return windows.length > 0
    ? makeUsageLimits({ checkedAt, windows })
    : makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
}

export interface CursorAccountUsage {
  readonly usageLimits: ServerProviderUsageLimits;
  readonly planLabel?: string;
}

export const readCursorAccountUsage = Effect.fn("readCursorAccountUsage")(function* (
  settings: Pick<CursorSettings, "apiEndpoint">,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* Effect.gen(function* () {
    const endpoint = (
      settings.apiEndpoint?.trim() ||
      environment.CURSOR_API_ENDPOINT?.trim() ||
      DEFAULT_CURSOR_API_ENDPOINT
    ).replace(/\/$/, "");
    let token = environment.CURSOR_AUTH_TOKEN?.trim();
    const apiKey = environment.CURSOR_API_KEY?.trim();
    if (!token && apiKey) {
      if (endpoint !== DEFAULT_CURSOR_API_ENDPOINT) {
        return {
          usageLimits: makeUnavailableUsageLimits({
            checkedAt,
            reason: "unsupported",
            message: "Cursor usage for an API key requires the default Cursor endpoint.",
          }),
        } satisfies CursorAccountUsage;
      }
      token = yield* exchangeCursorApiKey(apiKey);
    }
    if (!token) {
      return {
        usageLimits: makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" }),
      } satisfies CursorAccountUsage;
    }
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(`${endpoint}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeaders({
          "connect-protocol-version": "1",
          "x-cursor-client-type": "cli",
        }),
        HttpClientRequest.bodyJsonUnsafe({}),
      ),
    );
    const body = yield* HttpClientResponse.schemaBodyJson(CursorUsageResponse)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    const planLabel = cursorPlanLabel(body);
    return {
      usageLimits: cursorUsageResponseToLimits(body, checkedAt),
      ...(planLabel ? { planLabel } : {}),
    } satisfies CursorAccountUsage;
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed((): CursorAccountUsage => ({
      usageLimits: makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Cursor could not read usage limits.",
      }),
    })),
  );
});

export const readCursorUsageLimits = Effect.fn("readCursorUsageLimits")(function* (
  settings: Pick<CursorSettings, "apiEndpoint">,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const result = yield* readCursorAccountUsage(settings, environment);
  return result.usageLimits;
});
