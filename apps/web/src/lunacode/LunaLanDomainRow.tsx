import { useState } from "react";
import type { AdvertisedEndpoint } from "@t3tools/contracts";

import { endpointDefaultPreferenceKey } from "../components/settings/ConnectionsSettings.logic";
import { SettingsRow } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { extractPortFromEndpoints, normalizeCustomLanEndpointUrl } from "./lanDomain.logic";

interface LunaLanDomainRowProps {
  readonly lanEndpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly customLanHost: string;
  readonly defaultEndpointKey: string | null;
  readonly onSelectDefaultEndpoint: (endpoint: AdvertisedEndpoint) => void;
  readonly onSaveCustomLanHost: (normalizedUrl: string) => void;
  readonly onClearCustomLanHost: () => void;
}

function lanEndpointBadgeLabel(endpoint: AdvertisedEndpoint): string {
  if (endpoint.id.startsWith("desktop-lan-mdns:")) return ".local 本机域名";
  if (endpoint.id.startsWith("desktop-lan-custom:")) return "自定义域名";
  if (endpoint.id.startsWith("desktop-lan:")) return "局域网 IP";
  return endpoint.label;
}

export function LunaLanDomainRow({
  lanEndpoints,
  customLanHost,
  defaultEndpointKey,
  onSelectDefaultEndpoint,
  onSaveCustomLanHost,
  onClearCustomLanHost,
}: LunaLanDomainRowProps) {
  const [draft, setDraft] = useState(customLanHost);
  const [syncedCustomLanHost, setSyncedCustomLanHost] = useState(customLanHost);
  const [validationError, setValidationError] = useState<string | null>(null);

  if (syncedCustomLanHost !== customLanHost) {
    setSyncedCustomLanHost(customLanHost);
    setDraft(customLanHost);
    setValidationError(null);
  }

  const defaultPort = extractPortFromEndpoints(lanEndpoints);
  const trimmedDraft = draft.trim();
  const preview = trimmedDraft ? normalizeCustomLanEndpointUrl(trimmedDraft, defaultPort) : null;

  const handleSave = () => {
    const result = normalizeCustomLanEndpointUrl(draft, defaultPort);
    if (!result.ok) {
      setValidationError(result.error);
      return;
    }
    setValidationError(null);
    setDraft(result.url);
    setSyncedCustomLanHost(result.url);
    onSaveCustomLanHost(result.url);
  };

  const handleClear = () => {
    setValidationError(null);
    setDraft("");
    setSyncedCustomLanHost("");
    onClearCustomLanHost();
  };

  return (
    <SettingsRow
      title="局域网域名访问"
      description={
        <span>
          优先使用 <code className="font-mono text-foreground">.local</code>{" "}
          局域网域名或自定义域名/反代端口生成默认连接与二维码；同一局域网内 DHCP 更换 IP
          时无需重新配对。
        </span>
      }
      status={
        validationError ? (
          <span className="block text-destructive">{validationError}</span>
        ) : preview?.ok ? (
          <span className="block text-muted-foreground">
            规范化地址：
            <code className="font-mono text-foreground">{preview.url}</code>
          </span>
        ) : null
      }
    >
      <div className="space-y-2.5 pb-2">
        {lanEndpoints.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {lanEndpoints.map((endpoint) => {
              const endpointKey = endpointDefaultPreferenceKey(endpoint);
              const isDefault = endpointKey === defaultEndpointKey;
              return (
                <button
                  key={endpoint.id}
                  type="button"
                  onClick={() => onSelectDefaultEndpoint(endpoint)}
                  className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                    isDefault
                      ? "border-primary/50 bg-primary/10 text-foreground"
                      : "border-border/75 bg-background/70 text-muted-foreground hover:border-border hover:text-foreground"
                  }`}
                >
                  <span className="font-medium">{lanEndpointBadgeLabel(endpoint)}</span>
                  <code className="font-mono text-2xs">{endpoint.httpBaseUrl}</code>
                  {isDefault ? (
                    <span className="rounded bg-primary/15 px-1 py-px text-4xs font-medium text-primary">
                      默认
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              if (validationError) setValidationError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleSave();
              }
            }}
            placeholder={`例如 mac-studio.local:${defaultPort} 或 http://mac-studio.local:8000/`}
            aria-label="自定义局域网域名或 URL"
            className="min-w-56 flex-1"
          />
          <Button size="sm" variant="outline" onClick={handleSave}>
            保存并设为默认
          </Button>
          {customLanHost ? (
            <Button size="sm" variant="ghost" onClick={handleClear}>
              清除
            </Button>
          ) : null}
        </div>
      </div>
    </SettingsRow>
  );
}
