import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
  PUSH_HOOKS_APPROVAL_LABEL,
  PUSH_HOOKS_APPROVAL_QUESTION,
} from "@t3tools/client-runtime/state/thread-requests";
import { T, useMessages } from "gt-react";
import { ShieldIcon } from "lucide-react";
import { memo, use } from "react";
import { APPROVAL_KIND_META } from "../../lunacode/approvalPresentation";
import { type PendingApproval } from "../../session-logic";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ApprovalText } from "./ApprovalText";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { PushHooksApprovalDetails } from "./PushHooksApprovalDetails";
import { ToolActivityIconView, type WorkEntryIconName } from "./TimelineToolActivityIcon";
import { TimelineRowCtx } from "./timelineRowContext";

const APPROVAL_ICON_BY_KIND = {
  command: "terminal",
  "file-change": "square-pen",
  "file-read": "eye",
  permission: "wrench",
  "mcp-elicitation": "hammer",
} satisfies Record<PendingApproval["requestKind"], WorkEntryIconName>;

export const TimelinePendingApprovalRow = memo(function TimelinePendingApprovalRow({
  approval,
}: {
  approval: PendingApproval;
}) {
  const { respondingRequestIds, canOperateThread, onRespondToApproval } = use(TimelineRowCtx);
  const m = useMessages();
  const meta = APPROVAL_KIND_META[approval.requestKind];
  const { pushHooks } = approval;
  const label = pushHooks ? PUSH_HOOKS_APPROVAL_LABEL : meta.label;
  const iconName = pushHooks ? "terminal" : APPROVAL_ICON_BY_KIND[approval.requestKind];
  const canRespond = approval.responseCapability === "live";

  return (
    <div
      role="group"
      aria-label={m(label)}
      data-v2-item-type="approval_request"
      className="my-1.5 rounded-xl border border-warning/35 bg-warning/6 px-3.5 py-2.5 text-xs shadow-xs"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <ToolActivityIconView
          icon={undefined}
          fallbackName={iconName}
          className="block size-4 shrink-0 stroke-2 text-warning"
          muted={false}
        />
        <span className="inline-flex items-center gap-1 font-semibold text-warning">
          <ShieldIcon aria-hidden className="size-3.5 shrink-0" />
          <T>Waiting for approval</T>
        </span>
        <span aria-hidden className="text-muted-foreground/60">
          ·
        </span>
        <span className="font-medium text-foreground">{m(label)}</span>
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
              aria-label={m(FULL_ACCESS_OVERRIDE_QUESTION)}
              tooltipStyle
              side="top"
              className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
            >
              {fullAccessOverrideExplanation(approval.fullAccessOverride, m)}
            </PopoverPopup>
          </Popover>
        ) : null}
      </div>

      <div className="mt-2 rounded-lg border border-border/70 bg-background/85 px-2.5 py-2">
        {pushHooks ? (
          <>
            <span className="block min-w-0 text-foreground select-text! wrap-anywhere">
              {m(PUSH_HOOKS_APPROVAL_QUESTION)}
            </span>
            <div className="mt-1.5">
              <PushHooksApprovalDetails pushHooks={pushHooks} />
            </div>
          </>
        ) : (
          <ApprovalText text={approval.detail || m(meta.label)} label={m(meta.detailLabel)} />
        )}
      </div>

      {approval.reason ? (
        <p className="mt-2 text-muted-foreground select-text wrap-anywhere">{approval.reason}</p>
      ) : null}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {canRespond ? (
          onRespondToApproval ? (
            <ComposerPendingApprovalActions
              presentation="composer"
              requestId={approval.requestId}
              disabled={!canOperateThread}
              isResponding={respondingRequestIds.includes(approval.requestId)}
              canRespond={canRespond}
              options={approval.options}
              onRespondToApproval={onRespondToApproval}
            />
          ) : null
        ) : (
          <span className="text-warning">
            <T>Provider process is gone. Interrupt or restart the run to respond.</T>
          </span>
        )}
      </div>
    </div>
  );
});
