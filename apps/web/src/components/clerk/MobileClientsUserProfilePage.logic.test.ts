import type { RelayClientDeviceRecord } from "@t3tools/contracts/relay";
import { describe, expect, it } from "vite-plus/test";

import { mobileClientPlatformLabel } from "./MobileClientsUserProfilePage.logic";

function makeDevice(overrides: Partial<RelayClientDeviceRecord>): RelayClientDeviceRecord {
  return {
    deviceId: "dev-1",
    label: "Device",
    platform: "ios",
    iosMajorVersion: 27,
    appVersion: "2.3.0",
    notifications: {
      enabled: false,
      notifyOnApproval: true,
      notifyOnInput: true,
      notifyOnCompletion: false,
      notifyOnFailure: true,
    },
    liveActivities: {
      enabled: false,
    },
    updatedAt: "2026-11-26T00:00:00.000Z",
    ...overrides,
  };
}

describe("MobileClientsUserProfilePage.logic", () => {
  it("formats mobile client platform labels with LunaCode brand", () => {
    expect(mobileClientPlatformLabel(makeDevice({ platform: "ios", iosMajorVersion: 27 }))).toBe(
      "iOS 27 · LunaCode 2.3.0",
    );
    expect(
      mobileClientPlatformLabel(makeDevice({ platform: "android", iosMajorVersion: null })),
    ).toBe("Android · LunaCode 2.3.0");
  });
});
