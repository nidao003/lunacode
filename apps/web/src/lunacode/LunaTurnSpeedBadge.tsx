import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

interface LunaTurnSpeedBadgeProps {
  readonly speed: number | undefined;
}

export function LunaTurnSpeedBadge({ speed }: LunaTurnSpeedBadgeProps) {
  if (speed === undefined || !Number.isFinite(speed) || speed <= 0) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="text-muted-foreground/80 font-mono text-2xs tabular-nums" />}
      >
        均速 {speed.toFixed(1)} tok/s
      </TooltipTrigger>
      <TooltipPopup>按本轮完成时长估算的平均输出速度</TooltipPopup>
    </Tooltip>
  );
}
