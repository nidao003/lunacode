import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import { SecretStorePersistError } from "./ServerSecretStore.ts";
import { mapDpopReplayStoreError, resolveDpopRequestUrl } from "./dpop.ts";

const storeFailure = (tag: "AlreadyExists" | "PermissionDenied") =>
  new SecretStorePersistError({
    resource: "DPoP proof",
    cause: PlatformError.systemError({
      _tag: tag,
      module: "FileSystem",
      method: "open",
      pathOrDescriptor: "dpop-proof.bin",
    }),
  });

describe("mapDpopReplayStoreError", () => {
  it("reports replay conflicts as invalid credentials", () => {
    const cause = storeFailure("AlreadyExists");
    const error = mapDpopReplayStoreError(cause);

    expect(error._tag).toBe("ServerAuthInvalidCredentialError");
    if (error._tag === "ServerAuthInvalidCredentialError") {
      expect(error.cause).toBe(cause);
      expect(error.dpopFailureReason).toBe("replay");
    }
  });
});

describe("resolveDpopRequestUrl", () => {
  it("prepends validated x-forwarded-prefix and preserves forwarded port/proto for DPoP htu matching", () => {
    const req = HttpServerRequest.fromWeb(
      new Request("http://127.0.0.1:3773/oauth/token", {
        method: "POST",
        headers: {
          host: "connect.example.com:8443",
          "x-forwarded-proto": "https",
          "x-forwarded-prefix": "/t/env-abc123",
        },
      }),
    );
    const resolved = resolveDpopRequestUrl(req);
    expect(Option.isSome(resolved)).toBe(true);
    expect(Option.getOrNull(resolved)?.href).toBe(
      "https://connect.example.com:8443/t/env-abc123/oauth/token",
    );

    const wsReq = HttpServerRequest.fromWeb(
      new Request("http://127.0.0.1:3773/ws?wsTicket=tok1", {
        method: "GET",
        headers: {
          host: "connect.example.com:8443",
          "x-forwarded-proto": "https",
          "x-forwarded-prefix": "/t/env-abc123",
        },
      }),
    );
    const resolvedWs = resolveDpopRequestUrl(wsReq);
    expect(Option.getOrNull(resolvedWs)?.href).toBe(
      "https://connect.example.com:8443/t/env-abc123/ws?wsTicket=tok1",
    );
  });

  it("ignores invalid x-forwarded-prefix headers", () => {
    for (const badPrefix of ["/admin", "//evil.com", "/t/a/b", "/t/../x"]) {
      const req = HttpServerRequest.fromWeb(
        new Request("http://127.0.0.1:3773/oauth/token", {
          method: "POST",
          headers: {
            host: "connect.example.com:8443",
            "x-forwarded-proto": "https",
            "x-forwarded-prefix": badPrefix,
          },
        }),
      );
      expect(Option.getOrNull(resolveDpopRequestUrl(req))?.href).toBe(
        "https://connect.example.com:8443/oauth/token",
      );
    }
  });
});
