import { splitsSurrogatePair } from "@t3tools/shared/assistantCitations";
import { createFileRoute } from "@tanstack/react-router";

import {
  LunaBotsWorkspace,
  type BotsHubTab,
  type BotsSearch,
} from "../lunacode/bots/LunaBotsWorkspace";

const sliceParam = (value: string) => value.slice(0, splitsSurrogatePair(value, 200) ? 199 : 200);

function parseTab(raw: unknown): BotsHubTab | undefined {
  return raw === "tasks" || raw === "bots" || raw === "automations" ? raw : undefined;
}

export const Route = createFileRoute("/_chat/bots")({
  validateSearch: (raw: Record<string, unknown>): BotsSearch => {
    const tab = parseTab(raw.tab);
    return {
      ...(typeof raw.env === "string" && raw.env ? { env: sliceParam(raw.env) } : {}),
      ...(typeof raw.bot === "string" && raw.bot ? { bot: sliceParam(raw.bot) } : {}),
      ...(typeof raw.task === "string" && raw.task ? { task: sliceParam(raw.task) } : {}),
      ...(tab ? { tab } : {}),
    };
  },
  component: LunaBotsWorkspace,
});
