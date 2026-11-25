import { describe, expect, it } from "vite-plus/test";
import { createAdvertisedEndpoint } from "@t3tools/shared/advertisedEndpoint";
import {
  buildCustomLanAdvertisedEndpoint,
  extractPortFromEndpoints,
  mergeCustomLanAdvertisedEndpoint,
  normalizeCustomLanEndpointUrl,
} from "./lanDomain.logic";

const coreProvider = {
  id: "desktop-core",
  label: "Desktop",
  kind: "core" as const,
  isAddon: false,
};

const sampleLanEndpoint = createAdvertisedEndpoint({
  id: "desktop-lan:http://192.168.3.189:3773",
  label: "Local network",
  provider: coreProvider,
  source: "desktop-core",
  httpBaseUrl: "http://192.168.3.189:3773",
  reachability: "lan",
});

describe("normalizeCustomLanEndpointUrl", () => {
  it("normalizes bare hostnames, host:port, and explicit http/https URLs", () => {
    expect(normalizeCustomLanEndpointUrl("daodao-2.local", 3773)).toEqual({
      ok: true,
      url: "http://daodao-2.local:3773/",
    });
    expect(normalizeCustomLanEndpointUrl("daodao-2.local:8000", 3773)).toEqual({
      ok: true,
      url: "http://daodao-2.local:8000/",
    });
    expect(normalizeCustomLanEndpointUrl("http://daodao-2.local:8000/", 3773)).toEqual({
      ok: true,
      url: "http://daodao-2.local:8000/",
    });
    expect(normalizeCustomLanEndpointUrl("https://mac.lan", 3773)).toEqual({
      ok: true,
      url: "https://mac.lan/",
    });
  });

  it("rejects empty inputs, unsupported schemes, paths, queries, fragments, and credentials", () => {
    expect(normalizeCustomLanEndpointUrl("", 3773).ok).toBe(false);
    expect(normalizeCustomLanEndpointUrl("ftp://daodao-2.local", 3773).ok).toBe(false);
    expect(normalizeCustomLanEndpointUrl("http://daodao-2.local:8000/app", 3773).ok).toBe(false);
    expect(normalizeCustomLanEndpointUrl("http://daodao-2.local:8000?a=1", 3773).ok).toBe(false);
    expect(normalizeCustomLanEndpointUrl("http://user:pass@daodao-2.local", 3773).ok).toBe(false);
    expect(normalizeCustomLanEndpointUrl("bad host", 3773).ok).toBe(false);
  });
});

describe("mergeCustomLanAdvertisedEndpoint", () => {
  it("extracts port and appends unique custom LAN endpoints", () => {
    expect(extractPortFromEndpoints([sampleLanEndpoint])).toBe(3773);

    const merged = mergeCustomLanAdvertisedEndpoint([sampleLanEndpoint], "daodao-2.local:8000");
    expect(merged).toHaveLength(2);
    expect(merged[1]?.id).toBe("desktop-lan-custom:http://daodao-2.local:8000/");
    expect(merged[1]?.httpBaseUrl).toBe("http://daodao-2.local:8000/");
    expect(merged[1]?.reachability).toBe("lan");
  });

  it("skips invalid or duplicate endpoints", () => {
    const mdns = buildCustomLanAdvertisedEndpoint("192.168.3.189:3773", 3773);
    expect(mdns?.httpBaseUrl).toBe("http://192.168.3.189:3773/");
    expect(
      mergeCustomLanAdvertisedEndpoint([sampleLanEndpoint], "192.168.3.189:3773"),
    ).toHaveLength(1);
    expect(mergeCustomLanAdvertisedEndpoint([sampleLanEndpoint], "bad host")).toHaveLength(1);
  });
});
