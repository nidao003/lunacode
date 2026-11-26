import { describe, expect, it, vi } from "vite-plus/test";

import {
  LUNACODE_GITHUB_LATEST_RELEASE_URL,
  LUNACODE_GITHUB_RELEASES_API_URL,
  checkLatestMobileRelease,
  findLatestMobileRelease,
  parseGitHubReleasesResponse,
} from "./mobileReleaseUpdate.logic.ts";

describe("mobileReleaseUpdate.logic", () => {
  it("picks the newest stable lunacode-v release and selects the matching Android APK or iOS IPA asset", () => {
    const releases = parseGitHubReleasesResponse([
      {
        tag_name: "lunacode-v0.2.0-nightly.20261126.1",
        draft: false,
        prerelease: true,
        html_url:
          "https://github.com/nidao003/lunacode/releases/tag/lunacode-v0.2.0-nightly.20261126.1",
        assets: [
          {
            name: "LunaCode-mobile-0.2.0-arm64-v8a-release.apk",
            browser_download_url: "https://example.invalid/nightly.apk",
          },
        ],
      },
      {
        tag_name: "lunacode-v0.1.14",
        draft: true,
        prerelease: false,
        html_url: "https://github.com/nidao003/lunacode/releases/tag/lunacode-v0.1.14",
        assets: [],
      },
      {
        tag_name: "lunacode-v0.1.13",
        draft: false,
        prerelease: false,
        html_url: "https://github.com/nidao003/lunacode/releases/tag/lunacode-v0.1.13",
        assets: [
          {
            name: "LunaCode-mobile-0.1.13-arm64-v8a-release.apk",
            browser_download_url:
              "https://github.com/nidao003/lunacode/releases/download/lunacode-v0.1.13/LunaCode-mobile-0.1.13-arm64-v8a-release.apk",
          },
          {
            name: "LunaCode-mobile-0.1.13-unsigned.ipa",
            browser_download_url:
              "https://github.com/nidao003/lunacode/releases/download/lunacode-v0.1.13/LunaCode-mobile-0.1.13-unsigned.ipa",
          },
        ],
      },
      {
        tag_name: "lunacode-v0.1.12",
        draft: false,
        prerelease: false,
        html_url: "https://github.com/nidao003/lunacode/releases/tag/lunacode-v0.1.12",
        assets: [],
      },
    ]);

    const androidResult = findLatestMobileRelease(releases, "0.1.12", "android");
    expect(androidResult).toEqual({
      status: "update-available",
      currentVersion: "0.1.12",
      latestVersion: "0.1.13",
      releaseUrl: "https://github.com/nidao003/lunacode/releases/tag/lunacode-v0.1.13",
      downloadUrl:
        "https://github.com/nidao003/lunacode/releases/download/lunacode-v0.1.13/LunaCode-mobile-0.1.13-arm64-v8a-release.apk",
    });

    const iosResult = findLatestMobileRelease(releases, "0.1.13", "ios");
    expect(iosResult).toEqual({
      status: "up-to-date",
      currentVersion: "0.1.13",
      latestVersion: "0.1.13",
      releaseUrl: "https://github.com/nidao003/lunacode/releases/tag/lunacode-v0.1.13",
      downloadUrl:
        "https://github.com/nidao003/lunacode/releases/download/lunacode-v0.1.13/LunaCode-mobile-0.1.13-unsigned.ipa",
    });
  });

  it("queries nidao003/lunacode GitHub Releases and falls back to /releases/latest on API quota limit", async () => {
    const requestedUrls: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      requestedUrls.push(url);
      if (url === LUNACODE_GITHUB_RELEASES_API_URL) {
        return new Response("rate limited", { status: 403 });
      }
      if (url === LUNACODE_GITHUB_LATEST_RELEASE_URL) {
        return Response.json({
          tag_name: "lunacode-v0.1.15",
          draft: false,
          prerelease: false,
        });
      }
      return new Response(null, { status: 404 });
    });

    const result = await checkLatestMobileRelease({
      currentVersion: "0.1.12",
      platform: "ios",
      fetchFn,
    });

    expect(requestedUrls).toEqual([
      LUNACODE_GITHUB_RELEASES_API_URL,
      LUNACODE_GITHUB_LATEST_RELEASE_URL,
    ]);
    expect(result).toEqual({
      status: "update-available",
      currentVersion: "0.1.12",
      latestVersion: "0.1.15",
      releaseUrl: "https://github.com/nidao003/lunacode/releases/tag/lunacode-v0.1.15",
      downloadUrl: null,
    });
  });
});
