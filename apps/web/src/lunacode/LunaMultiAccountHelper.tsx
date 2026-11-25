import { useState } from "react";
import type { ProviderDriverKind } from "@t3tools/contracts";
import { Button } from "~/components/ui/button";
import { buildClaudeIsolatedLoginCommand, buildIsolatedClaudeHomePath } from "./multiAccount.logic";

interface LunaMultiAccountHelperProps {
  readonly driver: ProviderDriverKind;
  readonly instanceId: string;
  readonly configDraft: Record<string, unknown>;
  readonly onUpdateConfig: (next: Record<string, unknown>) => void;
}

export function LunaMultiAccountHelper({
  driver,
  instanceId,
  configDraft,
  onUpdateConfig,
}: LunaMultiAccountHelperProps) {
  const [copiedCmd, setCopiedCmd] = useState(false);

  const currentHomePath =
    typeof configDraft.homePath === "string" && configDraft.homePath.trim().length > 0
      ? configDraft.homePath.trim()
      : null;

  const suggestedClaudeHome = buildIsolatedClaudeHomePath(instanceId);
  const loginCommand = buildClaudeIsolatedLoginCommand(currentHomePath ?? suggestedClaudeHome);

  const copyCommand = () => {
    void navigator.clipboard.writeText(loginCommand).then(
      () => setCopiedCmd(true),
      () => setCopiedCmd(false),
    );
  };

  return (
    <div className="mb-3 space-y-2 rounded-lg border border-border/70 bg-muted/25 p-3 text-xs">
      <div className="font-medium text-foreground">
        合规提示：多账号配置目录彼此隔离，仅用于按需手动切换，禁止自动轮询池化或绕过官方限流。
      </div>

      {driver === "claudeAgent" ? (
        <div className="space-y-2 text-muted-foreground">
          <p>
            建议为每个 Claude 账号指定独立的 CLAUDE_CONFIG_DIR，避免覆盖系统默认的 ~/.claude
            登录凭证。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                onUpdateConfig({
                  ...configDraft,
                  homePath: suggestedClaudeHome,
                })
              }
            >
              自动填充独立目录 ({suggestedClaudeHome})
            </Button>
            <Button size="xs" variant="ghost-muted" onClick={copyCommand}>
              {copiedCmd ? "已复制登录命令" : "复制独立登录命令"}
            </Button>
          </div>
          <code className="block overflow-x-auto rounded border border-border/60 bg-background/80 px-2 py-1 font-mono text-2xs text-foreground">
            {loginCommand}
          </code>
        </div>
      ) : null}

      {driver === "antigravity" ? (
        <p className="text-muted-foreground">
          Antigravity 默认通过官方 `agy` CLI 原生凭据运行（需先在本机完成官方登录）。个人 Google
          订阅不建议使用多账号轮换或后台自动刷新；额度仅在手动点击刷新时通过官方 CLI
          查询，并保留至少 5 分钟本地缓存。
        </p>
      ) : null}

      {driver === "codex" ? (
        <p className="text-muted-foreground">
          如需额外隔离 Codex 配置，请在下方指定独立的 CODEX_HOME 目录，或使用上一步的托管 ChatGPT
          账号登录流程。
        </p>
      ) : null}
    </div>
  );
}
