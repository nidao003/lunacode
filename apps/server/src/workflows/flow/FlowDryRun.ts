import type { FlowDryRunReport, FlowSpec } from "@t3tools/contracts";

import { validateFlowSpec } from "./FlowValidator.ts";

export function dryRunFlowSpec(spec: FlowSpec): FlowDryRunReport {
  const result = validateFlowSpec(spec);
  return {
    valid: result.valid,
    workflowName: spec.name,
    version: spec.version,
    maxHops: spec.maxHops ?? 8,
    layers: result.layers,
    loopEdges: result.loopEdges,
    parallelWriteRisks: result.parallelWriteRisks,
    highRiskNodes: result.highRiskNodes,
    untrustedDataFields: result.untrustedDataFields,
    issues: result.issues,
  };
}
