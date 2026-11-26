import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import { type ProviderApprovalDecision, type RuntimeRequestId } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { ChevronLeftIcon, ChevronRightIcon, ShieldIcon, TriangleAlertIcon } from "lucide-react";
import { memo, useState } from "react";
import { ComposerBanner } from "../components/chat/ComposerBanner";
import { composerFloatingLayerProps } from "../components/chat/composerEventScope";
import { Button, InlineButton } from "../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { type PendingApproval } from "../session-logic";
import {
  APPROVAL_KIND_META,
  DEFAULT_APPROVAL_OPTIONS,
  approvalOptionButtonVariant,
  orderApprovalOptionsForBanner,
  resolveApprovalOptionLabel,
} from "./approvalPresentation";

interface LunaPendingApprovalBannerProps {
  approvals: ReadonlyArray<PendingApproval>;
  canOperateThread: boolean;
  respondingRequestIds: ReadonlyArray<RuntimeRequestId>;
  onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

export const LunaPendingApprovalBanner = memo(function LunaPendingApprovalBanner({
  approvals,
  canOperateThread,
  respondingRequestIds,
  onRespondToApproval,
}: LunaPendingApprovalBannerProps) {
  const gt = useGT();
  const m = useMessages();
  const [selectedRequestId, setSelectedRequestId] = useState<RuntimeRequestId | null>(null);

  if (approvals.length === 0) return null;

  const matchedIndex =
    selectedRequestId === null
      ? -1
      : approvals.findIndex((candidate) => candidate.requestId === selectedRequestId);
  const activeIndex = matchedIndex >= 0 ? matchedIndex : 0;
  const approval = approvals[activeIndex];
  if (!approval) return null;

  const meta = APPROVAL_KIND_META[approval.requestKind];
  const isBuiltInDefault = approval.options === undefined;
  const options = orderApprovalOptionsForBanner(approval.options ?? DEFAULT_APPROVAL_OPTIONS);
  const canRespond = approval.responseCapability === "live";
  const isResponding = respondingRequestIds.includes(approval.requestId);
  const disabled = !canOperateThread || isResponding || !canRespond;
  const isElicitation = approval.requestKind === "mcp-elicitation";

  const stepApproval = (delta: -1 | 1) => {
    const nextIndex = (activeIndex + delta + approvals.length) % approvals.length;
    const nextApproval = approvals[nextIndex];
    if (nextApproval) setSelectedRequestId(nextApproval.requestId);
  };

  return (
    <ComposerBanner.Root
      data-chat-composer-top-drawer="true"
      data-pending-approval-banner="true"
      data-chat-composer-collapsed-controls="true"
      variant="warning"
      density="spacious"
      role="region"
      aria-label={m(meta.label)}
    >
      <ComposerBanner.Row layout="approval">
        <ComposerBanner.Icon>
          <ShieldIcon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="flex-wrap gap-x-1.5 gap-y-1">
          <span className="font-semibold text-warning">
            <T>Waiting for approval</T>
          </span>
          <ComposerBanner.Separator />
          <span className="font-medium text-foreground">{m(meta.label)}</span>
          {approval.appName ? (
            <span className="rounded-md border border-border/70 bg-background/80 px-1.5 py-0.5 text-2xs font-medium text-foreground/85">
              {approval.appName}
            </span>
          ) : null}
          {approval.fullAccessOverride ? (
            <Popover>
              <PopoverTrigger openOnHover render={<InlineButton tone="muted" />}>
                {m(FULL_ACCESS_OVERRIDE_QUESTION)}
              </PopoverTrigger>
              <PopoverPopup
                {...composerFloatingLayerProps}
                aria-label={m(FULL_ACCESS_OVERRIDE_QUESTION)}
                tooltipStyle
                side="top"
                className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
              >
                {fullAccessOverrideExplanation(approval.fullAccessOverride, m)}
              </PopoverPopup>
            </Popover>
          ) : null}
        </ComposerBanner.Content>
        {approvals.length > 1 ? (
          <ComposerBanner.Actions className="gap-1">
            <ComposerBanner.Count>
              {activeIndex + 1}/{approvals.length}
            </ComposerBanner.Count>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={gt("Previous approval")}
              onClick={() => stepApproval(-1)}
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={gt("Next approval")}
              onClick={() => stepApproval(1)}
            >
              <ChevronRightIcon />
            </Button>
          </ComposerBanner.Actions>
        ) : null}
      </ComposerBanner.Row>

      <ComposerBanner.Body className="mt-2 ps-7 pe-1 sm:ps-6">
        {canRespond ? (
          <div className="rounded-lg border border-warning/25 bg-background/85 px-3 py-2">
            <code
              aria-label={m(meta.detailLabel)}
              data-approval-detail="banner"
              tabIndex={0}
              className={cn(
                "block max-h-36 min-w-0 overflow-auto whitespace-pre-wrap text-xs leading-5 text-foreground select-text! [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
                isElicitation ? "font-sans wrap-break-word" : "font-mono wrap-anywhere",
              )}
            >
              {approval.detail || m(meta.label)}
            </code>
          </div>
        ) : (
          <div className="rounded-lg border border-warning/30 bg-background/80 px-3 py-2 text-xs text-warning">
            <T>Provider process is gone. Interrupt or restart the run to respond.</T>
          </div>
        )}

        {approval.reason ? (
          <p className="mt-2 text-xs text-muted-foreground select-text wrap-anywhere">
            {approval.reason}
          </p>
        ) : null}

        {canRespond ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {options.map((option) => {
              const label = resolveApprovalOptionLabel(option.label, isBuiltInDefault, m);
              const button = (
                <Button
                  key={option.decision}
                  size="xs"
                  variant={approvalOptionButtonVariant(option.decision, Boolean(option.warning))}
                  disabled={disabled}
                  aria-description={option.warning}
                  onClick={() => {
                    if (!disabled) {
                      void onRespondToApproval(approval.requestId, option.decision);
                    }
                  }}
                >
                  {option.warning ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
                  <span>{label}</span>
                </Button>
              );

              return option.warning ? (
                <Tooltip key={option.decision}>
                  <TooltipTrigger render={button} />
                  <TooltipPopup side="top">{option.warning}</TooltipPopup>
                </Tooltip>
              ) : (
                button
              );
            })}
          </div>
        ) : null}
      </ComposerBanner.Body>
    </ComposerBanner.Root>
  );
});
