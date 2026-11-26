import { useState } from "react";
import { Linking, Platform } from "react-native";

import * as Dialog from "../components/ui/Dialog";
import { SettingsRow } from "../features/settings/components/SettingsRow";
import {
  LUNACODE_GITHUB_RELEASES_URL,
  checkLatestMobileRelease,
} from "./mobileReleaseUpdate.logic";

function openExternalUrl(url: string): void {
  void Linking.openURL(url).catch(() => {
    Dialog.alert("无法打开链接", `请手动访问：${url}`);
  });
}

async function checkAndPresentMobileRelease(options: {
  readonly currentVersion: string;
  readonly platform: string;
  readonly onStatusChange: (status: string) => void;
}): Promise<void> {
  options.onStatusChange("正在检查 nidao003/lunacode 新版本…");
  try {
    const result = await checkLatestMobileRelease({
      currentVersion: options.currentVersion,
      platform: options.platform,
    });

    if (result.status === "up-to-date") {
      options.onStatusChange(`已是最新版本 (${result.latestVersion})`);
      Dialog.alert("已是最新版本", `当前版本 ${result.currentVersion} 已是最新。`);
      return;
    }

    options.onStatusChange(`发现新版本 ${result.latestVersion}`);
    const downloadUrl = result.downloadUrl;
    const releaseUrl = result.releaseUrl || LUNACODE_GITHUB_RELEASES_URL;
    Dialog.alert(
      `发现新版本 v${result.latestVersion}`,
      `当前版本：${result.currentVersion}\n最新版本：${result.latestVersion}`,
      [
        ...(downloadUrl
          ? [
              {
                text: options.platform === "android" ? "下载 APK" : "下载 IPA",
                onPress: () => openExternalUrl(downloadUrl),
              },
            ]
          : []),
        {
          text: "查看 Release",
          onPress: () => openExternalUrl(releaseUrl),
        },
        { text: "取消", style: "cancel" as const },
      ],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onStatusChange("检查失败，点击重试");
    Dialog.alert("检查更新失败", message, [
      { text: "打开 Releases", onPress: () => openExternalUrl(LUNACODE_GITHUB_RELEASES_URL) },
      { text: "关闭", style: "cancel" as const },
    ]);
  }
}

export function LunaMobileReleaseUpdateRow(props: { readonly currentVersion: string }) {
  const [statusText, setStatusText] = useState("点击检查 GitHub 新版本");
  const [checking, setChecking] = useState(false);

  const handleCheck = async () => {
    if (checking) return;
    setChecking(true);
    await checkAndPresentMobileRelease({
      currentVersion: props.currentVersion,
      platform: Platform.OS,
      onStatusChange: setStatusText,
    });
    setChecking(false);
  };

  return (
    <SettingsRow
      icon="tray.and.arrow.down"
      label="检查新版本 (GitHub)"
      value={statusText}
      valuePosition="below"
      disabled={checking}
      onPress={() => {
        void handleCheck();
      }}
    />
  );
}
