import type { BotAccent, BotAvatarPreset, BotTaskStatus } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

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
    ring: "ring-info/30",
    text: "text-info-foreground",
    dot: "bg-info",
    badgeVariant: "info",
  },
  success: {
    tileBg: "bg-success/15 text-success-foreground",
    ring: "ring-success/30",
    text: "text-success-foreground",
    dot: "bg-success",
    badgeVariant: "success",
  },
  warning: {
    tileBg: "bg-warning/15 text-warning-foreground",
    ring: "ring-warning/30",
    text: "text-warning-foreground",
    dot: "bg-warning",
    badgeVariant: "warning",
  },
  primary: {
    tileBg: "bg-primary/15 text-primary",
    ring: "ring-primary/30",
    text: "text-primary",
    dot: "bg-primary",
    badgeVariant: "outline",
  },
  destructive: {
    tileBg: "bg-destructive/15 text-destructive-foreground",
    ring: "ring-destructive/30",
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
  readonly label: string;
}> = [
  { value: "scout", label: "侦察" },
  { value: "reviewer", label: "审查" },
  { value: "sentinel", label: "守望" },
  { value: "scribe", label: "文档" },
  { value: "builder", label: "构建" },
  { value: "coordinator", label: "调度" },
  { value: "ops", label: "运维" },
  { value: "spark", label: "灵感" },
];

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

function BotGlyph({ preset }: { readonly preset: BotAvatarPreset }) {
  switch (preset) {
    case "scout":
      return (
        <svg aria-hidden viewBox="0 0 24 24" className="size-[62%]" fill="none">
          <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="1.8" />
          <path d="M9.5 14.5L11 10.5L15 9L13.5 13L9.5 14.5Z" fill="currentColor" />
        </svg>
      );
    case "reviewer":
      return (
        <svg aria-hidden viewBox="0 0 24 24" className="size-[62%]" fill="none">
          <path
            d="M12 3.5L19 6.5V11.5C19 15.8 16 19.2 12 20.5C8 19.2 5 15.8 5 11.5V6.5L12 3.5Z"
            stroke="currentColor"
            strokeWidth="1.8"
          />
          <path
            d="M9.2 12.2L11.2 14.2L15 10"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "sentinel":
      return (
        <svg aria-hidden viewBox="0 0 24 24" className="size-[62%]" fill="none">
          <rect
            x="4.5"
            y="6"
            width="15"
            height="12"
            rx="4"
            stroke="currentColor"
            strokeWidth="1.8"
          />
          <circle cx="9.5" cy="12" r="1.4" fill="currentColor" />
          <circle cx="14.5" cy="12" r="1.4" fill="currentColor" />
        </svg>
      );
    case "scribe":
      return (
        <svg aria-hidden viewBox="0 0 24 24" className="size-[62%]" fill="none">
          <path
            d="M6.5 4.5H15L18.5 8V19.5H6.5V4.5Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <path
            d="M9.5 11.5H15.5M9.5 15H13.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      );
    case "builder":
      return (
        <svg aria-hidden viewBox="0 0 24 24" className="size-[62%]" fill="none">
          <path
            d="M7 7H17V17H7V7ZM10 4V7M14 4V7M10 17V20M14 17V20"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      );
    case "coordinator":
      return (
        <svg aria-hidden viewBox="0 0 24 24" className="size-[62%]" fill="none">
          <circle cx="12" cy="6.5" r="2.2" fill="currentColor" />
          <circle cx="6.5" cy="16.5" r="2.2" fill="currentColor" />
          <circle cx="17.5" cy="16.5" r="2.2" fill="currentColor" />
          <path
            d="M11 8.5L7.5 14.5M13 8.5L16.5 14.5M8.7 16.5H15.3"
            stroke="currentColor"
            strokeWidth="1.6"
          />
        </svg>
      );
    case "ops":
      return (
        <svg aria-hidden viewBox="0 0 24 24" className="size-[62%]" fill="none">
          <path
            d="M5 13H8.5L10.5 7.5L13.5 16.5L15.5 13H19"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "spark":
      return (
        <svg aria-hidden viewBox="0 0 24 24" className="size-[62%]" fill="none">
          <path
            d="M12 4L14.2 9.8L20 12L14.2 14.2L12 20L9.8 14.2L4 12L9.8 9.8L12 4Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
      );
  }
}

export function LunaBotAvatar({
  avatar,
  accent,
  size = "md",
  working = false,
  className,
}: {
  readonly avatar: BotAvatarPreset;
  readonly accent: BotAccent;
  readonly size?: "sm" | "md" | "lg";
  readonly working?: boolean;
  readonly className?: string;
}) {
  const palette = BOT_ACCENT_STYLES[accent];
  const sizeClass =
    size === "sm" ? "size-5 rounded-md" : size === "lg" ? "size-9 rounded-xl" : "size-7 rounded-lg";

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center ring-1",
        sizeClass,
        palette.tileBg,
        palette.ring,
        className,
      )}
    >
      <BotGlyph preset={avatar} />
      {working ? (
        <span
          aria-hidden
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-background",
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
