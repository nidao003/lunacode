import { assert, describe, it } from "vite-plus/test";

import { makeEnvironmentHttpApiUrlBuilder } from "../rpc/http.ts";
import { resolveAssetUrl } from "../state/assets.ts";
import { webhookAddress } from "../webhookAddress.ts";
import { environmentEndpointUrl, joinEnvironmentRelativeUrl } from "./endpoint.ts";

describe("environment endpoint helpers with non-default ports and tunnel path prefixes", () => {
  const rootBaseUrl = "https://connect.example.com:8443/";
  const prefixedBaseUrl = "https://connect.example.com:8443/t/env-abc123/";

  it("preserves non-443 port and tunnel path prefix in environmentEndpointUrl", () => {
    assert.equal(
      environmentEndpointUrl(rootBaseUrl, "/.well-known/t3/environment"),
      "https://connect.example.com:8443/.well-known/t3/environment",
    );
    assert.equal(
      environmentEndpointUrl(prefixedBaseUrl, "/.well-known/t3/environment"),
      "https://connect.example.com:8443/t/env-abc123/.well-known/t3/environment",
    );
    assert.equal(
      environmentEndpointUrl(prefixedBaseUrl, "/oauth/token"),
      "https://connect.example.com:8443/t/env-abc123/oauth/token",
    );
  });

  it("preserves tunnel path prefix in joinEnvironmentRelativeUrl, resolveAssetUrl, and webhookAddress", () => {
    assert.equal(
      joinEnvironmentRelativeUrl(prefixedBaseUrl, "/api/assets/tok/file.png"),
      "https://connect.example.com:8443/t/env-abc123/api/assets/tok/file.png",
    );
    assert.equal(
      resolveAssetUrl(prefixedBaseUrl, "/api/attachment-uploads/tok"),
      "https://connect.example.com:8443/t/env-abc123/api/attachment-uploads/tok",
    );
    assert.equal(
      joinEnvironmentRelativeUrl(prefixedBaseUrl, "assets/image.png"),
      "https://connect.example.com:8443/t/env-abc123/assets/image.png",
    );
    assert.equal(
      webhookAddress({ path: "/api/hooks/wh_1", url: null, hasSecret: false }, prefixedBaseUrl)
        .address,
      "https://connect.example.com:8443/t/env-abc123/api/hooks/wh_1",
    );
  });

  it("preserves tunnel path prefix in makeEnvironmentHttpApiUrlBuilder", () => {
    const urls = makeEnvironmentHttpApiUrlBuilder(prefixedBaseUrl);
    assert.equal(
      urls.metadata.descriptor(),
      "https://connect.example.com:8443/t/env-abc123/.well-known/t3/environment",
    );
    assert.equal(
      urls.auth.webSocketTicketFor({ params: { use: "rpc" } }),
      "https://connect.example.com:8443/t/env-abc123/api/auth/websocket-ticket/rpc",
    );
  });
});
