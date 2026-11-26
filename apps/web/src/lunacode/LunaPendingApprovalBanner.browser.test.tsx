import { RuntimeRequestId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import type { PendingApproval } from "../session-logic";
import { composerOwnsPendingApprovals } from "./approvalPresentation";
import { LunaPendingApprovalBanner } from "./LunaPendingApprovalBanner";

const COMMAND_APPROVAL: PendingApproval = {
  requestId: RuntimeRequestId.make("req-cmd"),
  requestKind: "command",
  createdAt: "2026-11-26T00:00:00.000Z",
  detail: "curl -sS https://example.com/health",
  reason: "Verify local endpoint connectivity",
  options: [
    { decision: "accept", label: "Allow once" },
    {
      decision: "acceptForSession",
      label: "Allow for this thread",
      warning: "Applies to future commands in this thread",
    },
    { decision: "decline", label: "Deny" },
    { decision: "cancel", label: "Cancel" },
  ],
  responseCapability: "live",
};

const FILE_APPROVAL: PendingApproval = {
  requestId: RuntimeRequestId.make("req-file"),
  requestKind: "file-change",
  createdAt: "2026-11-26T00:00:01.000Z",
  detail: "src/app.ts",
  appName: "Workspace",
  responseCapability: "live",
};

it("shows all approval details and direct action buttons without hiding secondary options", async () => {
  const onRespond = vi.fn(async () => {});
  await using screen = await render(
    <LunaPendingApprovalBanner
      approvals={[COMMAND_APPROVAL, FILE_APPROVAL]}
      canOperateThread
      respondingRequestIds={[]}
      onRespondToApproval={onRespond}
    />,
  );

  await expect.element(screen.getByRole("region", { name: "Command approval" })).toBeVisible();
  await expect.element(screen.getByText("Waiting for approval")).toBeVisible();
  await expect
    .element(screen.getByText("curl -sS https://example.com/health", { exact: true }))
    .toBeVisible();
  await expect.element(screen.getByText("Verify local endpoint connectivity")).toBeVisible();
  await expect.element(screen.getByText("1/2")).toBeVisible();

  await expect
    .element(screen.getByRole("button", { name: "Allow once", exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Allow for this thread", exact: true }))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();

  await screen.getByRole("button", { name: "Allow for this thread", exact: true }).click();
  expect(onRespond).toHaveBeenLastCalledWith(COMMAND_APPROVAL.requestId, "acceptForSession");

  await screen.getByRole("button", { name: "Next approval", exact: true }).click();
  await expect.element(screen.getByRole("region", { name: "File change approval" })).toBeVisible();
  await expect.element(screen.getByText("Workspace", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("2/2")).toBeVisible();

  await screen.getByRole("button", { name: "Approve", exact: true }).click();
  expect(onRespond).toHaveBeenLastCalledWith(FILE_APPROVAL.requestId, "accept");
});

it("disables buttons while responding and warns when provider is gone", async () => {
  const onRespond = vi.fn(async () => {});
  await using screen = await render(
    <LunaPendingApprovalBanner
      approvals={[COMMAND_APPROVAL]}
      canOperateThread
      respondingRequestIds={[COMMAND_APPROVAL.requestId]}
      onRespondToApproval={onRespond}
    />,
  );

  await expect
    .element(screen.getByRole("button", { name: "Allow once", exact: true }))
    .toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Deny", exact: true })).toBeDisabled();

  await screen.rerender(
    <LunaPendingApprovalBanner
      approvals={[{ ...COMMAND_APPROVAL, responseCapability: "not_resumable" }]}
      canOperateThread
      respondingRequestIds={[]}
      onRespondToApproval={onRespond}
    />,
  );

  await expect
    .element(screen.getByText("Provider process is gone. Interrupt or restart the run to respond."))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Allow once", exact: true }))
    .not.toBeInTheDocument();
});

it("keeps approval ownership on the composer banner unless unmounted or blocked by a question", () => {
  expect(composerOwnsPendingApprovals({ composerMounted: true, hasPendingUserInputs: false })).toBe(
    true,
  );
  expect(
    composerOwnsPendingApprovals({ composerMounted: false, hasPendingUserInputs: false }),
  ).toBe(false);
  expect(composerOwnsPendingApprovals({ composerMounted: true, hasPendingUserInputs: true })).toBe(
    false,
  );
});
