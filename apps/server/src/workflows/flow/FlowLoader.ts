import type { FlowSpec } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { WorkflowDefinition } from "../workflow.ts";
import { compileFlowSpec } from "./FlowCompiler.ts";
import { decodeStrictFlowSpecSync, validateFlowSpec } from "./FlowValidator.ts";

export class FlowDefinitionLoadError extends Schema.TaggedError<FlowDefinitionLoadError>()(
  "FlowDefinitionLoadError",
  {
    reason: Schema.String,
    line: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export function isFlowDefinitionFile(nameOrPath: string): boolean {
  return nameOrPath.endsWith(".flow.json");
}

function lineFromJsonError(source: string, error: unknown): number | undefined {
  if (!(error instanceof SyntaxError)) return undefined;
  const msg = error.message;
  const lineColMatch = /line\s+(\d+)/i.exec(msg);
  if (lineColMatch?.[1]) {
    const parsed = Number(lineColMatch[1]);
    if (Number.isInteger(parsed) && parsed >= 1) return parsed;
  }
  const posMatch = /position\s+(\d+)/i.exec(msg);
  if (posMatch?.[1]) {
    const pos = Number(posMatch[1]);
    if (Number.isInteger(pos) && pos >= 0) {
      let line = 1;
      for (let i = 0; i < pos && i < source.length; i++) {
        if (source[i] === "\n") line++;
      }
      return line;
    }
  }
  return undefined;
}

export function parseFlowSpecFromJson(source: string): FlowSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    const line = lineFromJsonError(source, error);
    throw new FlowDefinitionLoadError({
      reason: `JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`,
      ...(line !== undefined ? { line } : {}),
    });
  }
  try {
    return decodeStrictFlowSpecSync(parsed);
  } catch (error) {
    throw new FlowDefinitionLoadError({
      reason: `Flow Schema 校验失败: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

export function loadFlowDefinitionFromJson(
  source: string,
  fileName: string,
): WorkflowDefinition<unknown, unknown> {
  const spec = parseFlowSpecFromJson(source);
  const validation = validateFlowSpec(spec);
  const errors = validation.issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    const summary = errors.map((issue) => issue.message).join("; ");
    throw new FlowDefinitionLoadError({ reason: `${fileName}: ${summary}` });
  }
  return compileFlowSpec(spec);
}
