import {
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderRequestKind,
} from "@t3tools/contracts";
import { msg, type useMessages } from "gt-react";

type MessageResolver = ReturnType<typeof useMessages>;

export const APPROVAL_KIND_META = {
  command: {
    label: msg("Command approval"),
    detailLabel: msg("Command", { $context: "noun, shell command awaiting approval" }),
  },
  "file-change": {
    label: msg("File change approval"),
    detailLabel: msg("File change"),
  },
  "file-read": {
    label: msg("File read approval"),
    detailLabel: msg("File to read"),
  },
  permission: {
    label: msg("App permission approval"),
    detailLabel: msg("Permission request"),
  },
  "mcp-elicitation": {
    label: msg("App access approval"),
    detailLabel: msg("App access request"),
  },
} satisfies Record<ProviderRequestKind, { label: string; detailLabel: string }>;

export const DEFAULT_APPROVAL_OPTIONS = [
  {
    decision: "cancel",
    label: msg("Cancel", { $context: "verb, response to an approval request" }),
  },
  {
    decision: "decline",
    label: msg("Decline", { $context: "verb, response to an approval request" }),
  },
  { decision: "acceptForSession", label: msg("Always allow this session") },
  {
    decision: "accept",
    label: msg("Approve", { $context: "verb, response to an approval request" }),
  },
] satisfies ReadonlyArray<ProviderApprovalOption>;

const KNOWN_PROVIDER_APPROVAL_LABELS: Record<string, string> = {
  "Allow once": msg("Allow once"),
  "Allow for this thread": msg("Allow for this thread"),
  "Allow for this session": msg("Allow for this session"),
  "Always allow this session": msg("Always allow this session"),
  "Always allow": msg("Always allow"),
  "Allow all edits this session": msg("Allow all edits this session"),
  Approve: msg("Approve", { $context: "verb, response to an approval request" }),
  Deny: msg("Deny", { $context: "verb, response to an approval request" }),
  Decline: msg("Decline", { $context: "verb, response to an approval request" }),
  Cancel: msg("Cancel", { $context: "verb, response to an approval request" }),
};

export function resolveApprovalOptionLabel(
  label: string,
  isBuiltInDefault: boolean,
  resolve: MessageResolver,
): string {
  if (isBuiltInDefault) return resolve(label);
  const known = Object.hasOwn(KNOWN_PROVIDER_APPROVAL_LABELS, label)
    ? KNOWN_PROVIDER_APPROVAL_LABELS[label]
    : undefined;
  return known !== undefined ? resolve(known) : label;
}

const DECISION_DISPLAY_ORDER: Record<ProviderApprovalDecision, number> = {
  accept: 0,
  acceptForSession: 1,
  acceptAlways: 2,
  decline: 3,
  cancel: 4,
};

export function orderApprovalOptionsForBanner(
  options: ReadonlyArray<ProviderApprovalOption>,
): ReadonlyArray<ProviderApprovalOption> {
  return [...options].sort(
    (left, right) => DECISION_DISPLAY_ORDER[left.decision] - DECISION_DISPLAY_ORDER[right.decision],
  );
}

export function approvalOptionButtonVariant(
  decision: ProviderApprovalDecision,
  hasWarning?: boolean,
): "default" | "destructive-outline" | "warning-outline" | "outline" | "ghost-muted" {
  switch (decision) {
    case "accept":
      return "default";
    case "decline":
      return "destructive-outline";
    case "acceptForSession":
    case "acceptAlways":
      return hasWarning ? "warning-outline" : "outline";
    case "cancel":
      return "ghost-muted";
  }
}

export function composerOwnsPendingApprovals(input: {
  readonly composerMounted: boolean;
  readonly hasPendingUserInputs: boolean;
}): boolean {
  return input.composerMounted && !input.hasPendingUserInputs;
}
