import { TriangleAlertIcon } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";

export function LunaTunnelLimitNotice({
  onManageTunnels,
}: {
  readonly onManageTunnels: (() => void) | null;
}) {
  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>隧道配额已达上限</AlertTitle>
      <AlertDescription>
        已达到管理员分配的隧道上限，请解绑不用的设备或联系管理员提升配额。
      </AlertDescription>
      {onManageTunnels ? (
        <AlertAction>
          <Button size="sm" variant="outline" onClick={onManageTunnels}>
            管理已绑定设备
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}
