import { describe, expect, it } from "@effect/vitest";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, vi } from "vite-plus/test";

vi.mock("./dpop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dpop")>();
  return {
    ...actual,
    loadOrCreateProofKey: () =>
      Effect.succeed({
        publicJwk: {
          kty: "EC",
          crv: "P-256",
          x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
          y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
        },
        sign: () => Effect.succeed(new Uint8Array(64)),
      }),
  };
});

import * as Dpop from "./dpop";
import * as ManagedRelayLayer from "./managedRelayLayer";

describe("web managedRelayLayer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.effect(
    "suppresses b3 and traceparent propagation headers in lunacode mode so self-hosted preflight succeeds",
    () =>
      Effect.gen(function* () {
        vi.stubEnv("VITE_LUNACODE_AUTH_URL", "https://relay.example.test");
        vi.stubEnv("VITE_LUNACODE_CONNECT_URL", "");
        vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
        vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "");
        vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");

        const requests: Array<Request> = [];
        const fetchMock: typeof globalThis.fetch = async (input, init) => {
          const req = new Request(input, init);
          requests.push(req);
          return Response.json({
            challenge: "challenge-jwt",
            expiresAt: "2030-01-01T00:00:00.000Z",
          });
        };

        const testLayer = ManagedRelayLayer.layer("https://relay.example.test").pipe(
          Layer.provide(layerRemoteHttpClient(fetchMock)),
          Layer.provide(Dpop.layer),
        );

        const result = yield* Effect.gen(function* () {
          const relayClient = yield* ManagedRelay.ManagedRelayClient;
          return yield* relayClient.createEnvironmentLinkChallenge({
            clerkToken: "luna-token",
            payload: {
              notificationsEnabled: true,
              liveActivitiesEnabled: true,
              managedTunnelsEnabled: true,
            },
          });
        }).pipe(Effect.withSpan("test.createChallenge"), Effect.provide(testLayer));

        expect(result.challenge).toBe("challenge-jwt");
        expect(requests).toHaveLength(1);
        expect(requests[0]!.headers.get("authorization")).toBe("Bearer luna-token");
        expect(requests[0]!.headers.has("traceparent")).toBe(false);
        expect(requests[0]!.headers.has("b3")).toBe(false);
      }),
  );

  it.effect("preserves traceparent propagation in clerk mode", () =>
    Effect.gen(function* () {
      vi.stubEnv("VITE_LUNACODE_AUTH_URL", "");
      vi.stubEnv("VITE_LUNACODE_CONNECT_URL", "");
      vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==");
      vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-connect");
      vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");

      const requests: Array<Request> = [];
      const fetchMock: typeof globalThis.fetch = async (input, init) => {
        const req = new Request(input, init);
        requests.push(req);
        return Response.json({
          challenge: "challenge-jwt",
          expiresAt: "2030-01-01T00:00:00.000Z",
        });
      };

      const testLayer = ManagedRelayLayer.layer("https://relay.example.test").pipe(
        Layer.provide(layerRemoteHttpClient(fetchMock)),
        Layer.provide(Dpop.layer),
      );

      yield* Effect.gen(function* () {
        const relayClient = yield* ManagedRelay.ManagedRelayClient;
        return yield* relayClient.createEnvironmentLinkChallenge({
          clerkToken: "clerk-token",
          payload: {
            notificationsEnabled: true,
            liveActivitiesEnabled: true,
            managedTunnelsEnabled: true,
          },
        });
      }).pipe(Effect.withSpan("test.createChallenge"), Effect.provide(testLayer));

      expect(requests).toHaveLength(1);
      expect(requests[0]!.headers.get("traceparent")).toMatch(/^00-/u);
    }),
  );
});
