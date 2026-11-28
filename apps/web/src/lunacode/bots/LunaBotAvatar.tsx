import type { BotAccent, BotAvatarPreset, BotTaskStatus } from "@t3tools/contracts";
import { LUNA_BOT_AVATAR_META } from "@t3tools/shared/lunacodeBotPresets";

import builderAvatarImg from "../../../../../assets/lunacode/bots/builder.png";
import coordinatorAvatarImg from "../../../../../assets/lunacode/bots/coordinator.png";
import opsAvatarImg from "../../../../../assets/lunacode/bots/ops.png";
import reviewerAvatarImg from "../../../../../assets/lunacode/bots/reviewer.png";
import scoutAvatarImg from "../../../../../assets/lunacode/bots/scout.png";
import scribeAvatarImg from "../../../../../assets/lunacode/bots/scribe.png";
import sentinelAvatarImg from "../../../../../assets/lunacode/bots/sentinel.png";
import sparkAvatarImg from "../../../../../assets/lunacode/bots/spark.png";
import { cn } from "~/lib/utils";

const BOT_AVATAR_IMAGES: Readonly<Record<BotAvatarPreset, string>> = {
  scout: scoutAvatarImg,
  reviewer: reviewerAvatarImg,
  sentinel: sentinelAvatarImg,
  scribe: scribeAvatarImg,
  builder: builderAvatarImg,
  coordinator: coordinatorAvatarImg,
  ops: opsAvatarImg,
  spark: sparkAvatarImg,
};

export const BOT_ACCENT_STYLES: Readonly<
  Record<
    BotAccent,
    {
      readonly tileBg: string;
      readonly ring: string;
      readonly text: string;
      readonly dot: string;
      readonly badgeVariant: "info" | "success" | "warning" | "outline" | "error";
    }
  >
> = {
  info: {
    tileBg: "bg-info/15 text-info-foreground",
    ring: "ring-info/35",
    text: "text-info-foreground",
    dot: "bg-info",
    badgeVariant: "info",
  },
  success: {
    tileBg: "bg-success/15 text-success-foreground",
    ring: "ring-success/35",
    text: "text-success-foreground",
    dot: "bg-success",
    badgeVariant: "success",
  },
  warning: {
    tileBg: "bg-warning/15 text-warning-foreground",
    ring: "ring-warning/35",
    text: "text-warning-foreground",
    dot: "bg-warning",
    badgeVariant: "warning",
  },
  primary: {
    tileBg: "bg-primary/15 text-primary",
    ring: "ring-primary/35",
    text: "text-primary",
    dot: "bg-primary",
    badgeVariant: "outline",
  },
  destructive: {
    tileBg: "bg-destructive/15 text-destructive-foreground",
    ring: "ring-destructive/35",
    text: "text-destructive-foreground",
    dot: "bg-destructive",
    badgeVariant: "error",
  },
  neutral: {
    tileBg: "bg-muted text-muted-foreground",
    ring: "ring-border",
    text: "text-muted-foreground",
    dot: "bg-muted-foreground",
    badgeVariant: "outline",
  },
};

export const BOT_TASK_STATUS_META: Readonly<
  Record<
    BotTaskStatus,
    {
      readonly label: string;
      readonly badgeVariant: "warning" | "info" | "outline" | "success" | "error";
      readonly dotClass: string;
    }
  >
> = {
  needs_you: {
    label: "待你确认",
    badgeVariant: "warning",
    dotClass: "bg-warning",
  },
  in_progress: {
    label: "进行中",
    badgeVariant: "info",
    dotClass: "bg-info",
  },
  backlog: {
    label: "待办",
    badgeVariant: "outline",
    dotClass: "bg-muted-foreground/60",
  },
  done: {
    label: "已完成",
    badgeVariant: "success",
    dotClass: "bg-success",
  },
  cancelled: {
    label: "已取消",
    badgeVariant: "error",
    dotClass: "bg-destructive/70",
  },
};

export const BOT_AVATAR_PRESETS: ReadonlyArray<{
  readonly value: BotAvatarPreset;
  readonly personaName: string;
  readonly styleLabel: string;
  readonly label: string;
  readonly summary: string;
}> = LUNA_BOT_AVATAR_META.map((item) => ({
  value: item.preset,
  personaName: item.personaName,
  styleLabel: item.styleLabel,
  label: item.label,
  summary: item.summary,
}));

export const BOT_ACCENT_OPTIONS: ReadonlyArray<{
  readonly value: BotAccent;
  readonly label: string;
}> = [
  { value: "info", label: "海蓝" },
  { value: "success", label: "翠绿" },
  { value: "warning", label: "琥珀" },
  { value: "primary", label: "靛紫" },
  { value: "destructive", label: "珊瑚" },
  { value: "neutral", label: "石板" },
];

export function LunaBotAvatar({
  avatar,
  accent,
  size = "md",
  working = false,
  className,
}: {
  readonly avatar: BotAvatarPreset;
  readonly accent: BotAccent;
  readonly size?: "xs" | "sm" | "md" | "lg" | "xl";
  readonly working?: boolean;
  readonly className?: string;
}) {
  const palette = BOT_ACCENT_STYLES[accent];
  const sizeClass =
    size === "xs"
      ? "size-4 rounded"
      : size === "sm"
        ? "size-5 rounded-md"
        : size === "lg"
          ? "size-9 rounded-xl"
          : size === "xl"
            ? "size-11 rounded-xl"
            : "size-7 rounded-lg";
  const dotSizeClass =
    size === "xs" || size === "sm" ? "size-1.5" : size === "xl" ? "size-2.5" : "size-2";

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-visible ring-1",
        sizeClass,
        palette.tileBg,
        palette.ring,
        className,
      )}
    >
      <img
        src={BOT_AVATAR_IMAGES[avatar]}
        alt=""
        draggable={false}
        className="size-full rounded-[inherit] object-cover object-top select-none"
      />
      {working ? (
        <span
          aria-hidden
          className={cn(
            "absolute -right-0.5 -bottom-0.5 rounded-full ring-2 ring-background",
            dotSizeClass,
            palette.dot,
          )}
        />
      ) : null}
    </span>
  );
}

export function extractBotErrorMessage(failure: unknown): string {
  if (failure instanceof Error) return failure.message;
  if (
    typeof failure === "object" &&
    failure !== null &&
    "message" in failure &&
    typeof failure.message === "string"
  ) {
    return failure.message;
  }
  return String(failure);
}
