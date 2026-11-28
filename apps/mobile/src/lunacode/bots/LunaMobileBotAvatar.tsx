import type { BotAccent, BotAvatarPreset } from "@t3tools/contracts";
import { Image, type ImageSource } from "expo-image";
import { View } from "react-native";

// Static requires required by Metro bundler for all 8 BotAvatarPreset assets.
const MOBILE_BOT_AVATAR_SOURCES: Readonly<Record<BotAvatarPreset, ImageSource>> = {
  scout: require("../../../../../assets/lunacode/bots/scout.png"),
  reviewer: require("../../../../../assets/lunacode/bots/reviewer.png"),
  sentinel: require("../../../../../assets/lunacode/bots/sentinel.png"),
  scribe: require("../../../../../assets/lunacode/bots/scribe.png"),
  builder: require("../../../../../assets/lunacode/bots/builder.png"),
  coordinator: require("../../../../../assets/lunacode/bots/coordinator.png"),
  ops: require("../../../../../assets/lunacode/bots/ops.png"),
  spark: require("../../../../../assets/lunacode/bots/spark.png"),
};

const ACCENT_BORDER: Readonly<Record<BotAccent, string>> = {
  info: "border-info/50 bg-info/10",
  success: "border-success/50 bg-success/10",
  warning: "border-warning/50 bg-warning/10",
  primary: "border-primary/50 bg-primary/10",
  destructive: "border-destructive/50 bg-destructive/10",
  neutral: "border-border bg-subtle",
};

const ACCENT_DOT: Readonly<Record<BotAccent, string>> = {
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  primary: "bg-primary",
  destructive: "bg-destructive",
  neutral: "bg-foreground-muted",
};

export function LunaMobileBotAvatar({
  avatar,
  accent,
  size = 38,
  working = false,
}: {
  readonly avatar: BotAvatarPreset;
  readonly accent: BotAccent;
  readonly size?: number;
  readonly working?: boolean;
}) {
  const radius = Math.max(8, Math.round(size * 0.28));
  return (
    <View
      className={`relative shrink-0 border ${ACCENT_BORDER[accent]}`}
      style={{ width: size, height: size, borderRadius: radius }}
    >
      <Image
        source={MOBILE_BOT_AVATAR_SOURCES[avatar]}
        contentFit="cover"
        contentPosition="top"
        accessibilityIgnoresInvertColors
        style={{
          width: "100%",
          height: "100%",
          borderRadius: Math.max(6, radius - 1),
        }}
      />
      {working ? (
        <View
          className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-background ${ACCENT_DOT[accent]}`}
        />
      ) : null}
    </View>
  );
}
