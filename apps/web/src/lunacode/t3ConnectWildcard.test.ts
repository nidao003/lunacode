import { RelayManagedEndpoint } from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { t3ConnectMcpUrl } from "../cloud/t3ConnectState";

const decodeEndpoint = Schema.decodeUnknownSync(RelayManagedEndpoint);

describe("t3ConnectMcpUrl wildcard tunnel", () => {
  it("keeps non-443 port on thisMachine wildcard host", () => {
    expect(
      t3ConnectMcpUrl({
        thisMachine: true,
        tunnelHostname: "env-0123456789abcdef.example.com:8443",
        relayEndpoint: undefined,
      }),
    ).toBe("https://env-0123456789abcdef.example.com:8443/mcp");
  });

  it("recognizes t3_relay managed wildcard endpoint on non-443 port", () => {
    expect(
      t3ConnectMcpUrl({
        thisMachine: false,
        tunnelHostname: undefined,
        relayEndpoint: decodeEndpoint({
          httpBaseUrl: "https://env-0123456789abcdef.example.com:8443/",
          wsBaseUrl: "wss://env-0123456789abcdef.example.com:8443/",
          providerKind: "t3_relay",
        }),
      }),
    ).toBe("https://env-0123456789abcdef.example.com:8443/mcp");
  });

  it("still rejects manual endpoints", () => {
    expect(
      t3ConnectMcpUrl({
        thisMachine: false,
        tunnelHostname: undefined,
        relayEndpoint: decodeEndpoint({
          httpBaseUrl: "https://192.168.1.20:3773/",
          wsBaseUrl: "wss://192.168.1.20:3773/",
          providerKind: "manual",
        }),
      }),
    ).toBeNull();
  });
});
