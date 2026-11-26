import { CLI_RELEASES_PAGE_URL, cliReleaseChannelOf } from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";

export const LUNACODE_GITHUB_RELEASES_URL = CLI_RELEASES_PAGE_URL;
export const LUNACODE_GITHUB_LATEST_RELEASE_URL = `${CLI_RELEASES_PAGE_URL}/latest`;
export const LUNACODE_GITHUB_RELEASES_API_URL =
  "https://api.github.com/repos/nidao003/lunacode/releases?per_page=30";

const RELEASE_TAG_PATTERN = /^(?:lunacode-)?v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u;

interface MobileReleaseAsset {
  readonly name: string;
  readonly browserDownloadUrl: string;
}

interface MobileGitHubRelease {
  readonly tagName: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly htmlUrl: string;
  readonly assets: ReadonlyArray<MobileReleaseAsset>;
}

type MobileReleaseCheckResult = {
  readonly status: "up-to-date" | "update-available";
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly releaseUrl: string;
  readonly downloadUrl: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractMobileReleaseVersion(tagName: string): string | null {
  return RELEASE_TAG_PATTERN.exec(tagName.trim())?.[1] ?? null;
}

function parseGitHubRelease(raw: unknown): MobileGitHubRelease | null {
  if (!isRecord(raw) || typeof raw.tag_name !== "string") {
    return null;
  }
  const rawAssets = Array.isArray(raw.assets) ? raw.assets : [];
  const assets: MobileReleaseAsset[] = [];
  for (const item of rawAssets) {
    if (
      isRecord(item) &&
      typeof item.name === "string" &&
      typeof item.browser_download_url === "string"
    ) {
      assets.push({ name: item.name, browserDownloadUrl: item.browser_download_url });
    }
  }
  const tagName = raw.tag_name.trim();
  if (!tagName) return null;
  return {
    tagName,
    draft: raw.draft === true,
    prerelease: raw.prerelease === true,
    htmlUrl:
      typeof raw.html_url === "string" && raw.html_url.trim().length > 0
        ? raw.html_url.trim()
        : `${LUNACODE_GITHUB_RELEASES_URL}/tag/${encodeURIComponent(tagName)}`,
    assets,
  };
}

export function parseGitHubReleasesResponse(raw: unknown): ReadonlyArray<MobileGitHubRelease> {
  if (!Array.isArray(raw)) {
    throw new Error("GitHub Releases 响应格式无效");
  }
  const releases: MobileGitHubRelease[] = [];
  for (const item of raw) {
    const parsed = parseGitHubRelease(item);
    if (parsed) {
      releases.push(parsed);
    }
  }
  return releases;
}

function selectPlatformMobileAssetUrl(
  assets: ReadonlyArray<MobileReleaseAsset>,
  platform: string,
): string | null {
  const extension = platform === "android" ? ".apk" : platform === "ios" ? ".ipa" : null;
  if (!extension) return null;
  let fallbackUrl: string | null = null;
  for (const asset of assets) {
    const lowerName = asset.name.toLowerCase();
    if (!lowerName.endsWith(extension)) continue;
    if (platform === "android" && lowerName.includes("arm64")) {
      return asset.browserDownloadUrl;
    }
    if (fallbackUrl === null) {
      fallbackUrl = asset.browserDownloadUrl;
    }
  }
  return fallbackUrl;
}

export function findLatestMobileRelease(
  releases: ReadonlyArray<MobileGitHubRelease>,
  currentVersion: string,
  platform: string,
): MobileReleaseCheckResult | null {
  const channel = cliReleaseChannelOf(currentVersion);
  let best: { readonly release: MobileGitHubRelease; readonly version: string } | null = null;

  for (const release of releases) {
    if (release.draft) continue;
    const version = extractMobileReleaseVersion(release.tagName);
    if (version === null) continue;
    if (cliReleaseChannelOf(version) !== channel) continue;
    if (channel === "stable" && release.prerelease) continue;

    if (best === null || compareSemverVersions(version, best.version) > 0) {
      best = { release, version };
    }
  }

  if (best === null) {
    return null;
  }

  const hasUpdate = compareSemverVersions(best.version, currentVersion) > 0;
  return {
    status: hasUpdate ? "update-available" : "up-to-date",
    currentVersion,
    latestVersion: best.version,
    releaseUrl: best.release.htmlUrl,
    downloadUrl: selectPlatformMobileAssetUrl(best.release.assets, platform),
  };
}

export async function checkLatestMobileRelease(options: {
  readonly currentVersion: string;
  readonly platform: string;
  readonly fetchFn?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<MobileReleaseCheckResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchFn(LUNACODE_GITHUB_RELEASES_API_URL, {
    signal: options.signal,
    headers: { Accept: "application/vnd.github+json" },
  });

  if (response.ok) {
    const releases = parseGitHubReleasesResponse(await response.json());
    const result = findLatestMobileRelease(releases, options.currentVersion, options.platform);
    if (!result) {
      throw new Error("未找到可用的 LunaCode 发行版本");
    }
    return result;
  }

  if (cliReleaseChannelOf(options.currentVersion) === "stable") {
    const fallbackResponse = await fetchFn(LUNACODE_GITHUB_LATEST_RELEASE_URL, {
      signal: options.signal,
      headers: { Accept: "application/json" },
    });
    if (fallbackResponse.ok) {
      const release = parseGitHubRelease(await fallbackResponse.json());
      if (release) {
        const result = findLatestMobileRelease([release], options.currentVersion, options.platform);
        if (result) return result;
      }
    }
  }

  throw new Error(`检查更新失败（HTTP ${response.status}）`);
}
