import { describe, expect, it } from "vite-plus/test";
import { providerAuthReturnUrl } from "./providerAuthReturnUrl.ts";

describe("provider auth return destinations", () => {
  it.each(["t3code", "t3code-dev"])(
    "returns to %s Welcome and the selected settings instance",
    (scheme) => {
      expect(providerAuthReturnUrl(`${scheme}://app/welcome?code=secret#agents:machine-id`)).toBe(
        `${scheme}://app/welcome#agents:machine-id`,
      );
      expect(
        providerAuthReturnUrl(`${scheme}://app/settings/providers?instanceId=work&code=secret`),
      ).toBe(`${scheme}://app/settings/providers?instanceId=work`);
    },
  );
  it.each([
    "t3code://attacker/welcome",
    "t3code://app/welcome/../evil",
    "https://attacker.example/welcome",
  ])("rejects %s", (url) => expect(providerAuthReturnUrl(url)).toBeUndefined());

  it("allows configured self-hosted LUNACODE_CONNECT_URL origins", () => {
    const prev = process.env.LUNACODE_CONNECT_URL;
    process.env.LUNACODE_CONNECT_URL = "https://connect.example.com:8443";
    try {
      expect(
        providerAuthReturnUrl(
          "https://connect.example.com:8443/welcome?code=secret#agents:machine-id",
        ),
      ).toBe("https://connect.example.com:8443/welcome#agents:machine-id");
    } finally {
      if (prev === undefined) {
        delete process.env.LUNACODE_CONNECT_URL;
      } else {
        process.env.LUNACODE_CONNECT_URL = prev;
      }
    }
  });
});
