import type { AgentAction, AgentProposal } from "./proposal.js";

const MAX_OUTPUT_CHARS = 64_000;
const MAX_ACTIONS = 16;
const MAX_CONTEXT_ITEMS = 32;

export class AgentProposalOutputError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(`Invalid agent proposal output: ${issues.join("; ")}`);
    this.name = "AgentProposalOutputError";
  }
}

/**
 * Parse provider output into the small, versioned proposal contract. This checks
 * shape and bounds only; call validateProposal() next to apply application policy.
 */
export function parseAgentProposalOutput(value: unknown): AgentProposal {
  let parsed = value;
  if (typeof value === "string") {
    if (value.length > MAX_OUTPUT_CHARS) throw new AgentProposalOutputError([`output exceeds ${MAX_OUTPUT_CHARS} characters`]);
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new AgentProposalOutputError(["output must be valid JSON"]);
    }
  }

  const issues: string[] = [];
  const record = objectRecord(parsed, "proposal", issues);
  if (!record) throw new AgentProposalOutputError(issues);
  checkKeys(record, ["schemaVersion", "id", "createdAt", "objective", "assumptions", "evidence", "actions", "simulationRequired"], "proposal", issues);

  if (record.schemaVersion !== "1.0") issues.push("schemaVersion must be '1.0'");
  const id = boundedString(record.id, "id", 128, issues);
  const createdAt = boundedString(record.createdAt, "createdAt", 64, issues);
  if (createdAt && !Number.isFinite(Date.parse(createdAt))) issues.push("createdAt must be a valid date");
  const objective = boundedString(record.objective, "objective", 2_000, issues);
  const assumptions = stringList(record.assumptions, "assumptions", MAX_CONTEXT_ITEMS, issues);
  const evidence = stringList(record.evidence, "evidence", MAX_CONTEXT_ITEMS, issues);
  const actions = actionList(record.actions, issues);
  if (typeof record.simulationRequired !== "boolean") issues.push("simulationRequired must be a boolean");

  if (issues.length) throw new AgentProposalOutputError(issues);
  return {
    schemaVersion: "1.0",
    id: id!,
    createdAt: createdAt!,
    objective: objective!,
    assumptions: assumptions!,
    evidence: evidence!,
    actions: actions!,
    simulationRequired: record.simulationRequired as boolean,
  };
}

function objectRecord(value: unknown, path: string, issues: string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    issues.push(`${path} must be a plain object`);
    return undefined;
  }
  return value as Record<string, unknown>;
}

function checkKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.push(`${path}.${key} is not supported`);
}

function boundedString(value: unknown, path: string, maxLength: number, issues: string[]): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    issues.push(`${path} must be a non-empty string`);
    return undefined;
  }
  if (value.length > maxLength) issues.push(`${path} exceeds ${maxLength} characters`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) issues.push(`${path} contains control characters`);
  return value;
}

function stringList(value: unknown, path: string, maxItems: number, issues: string[]): string[] | undefined {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return undefined;
  }
  if (value.length > maxItems) issues.push(`${path} exceeds ${maxItems} items`);
  return value.map((item, index) => boundedString(item, `${path}[${index}]`, 2_000, issues) ?? "");
}

function actionList(value: unknown, issues: string[]): AgentAction[] | undefined {
  if (!Array.isArray(value)) {
    issues.push("actions must be an array");
    return undefined;
  }
  if (value.length > MAX_ACTIONS) issues.push(`actions exceeds ${MAX_ACTIONS} items`);
  return value.map((item, index) => {
    const path = `actions[${index}]`;
    const record = objectRecord(item, path, issues);
    if (!record) return { kind: "simulate", summary: "", risk: "low", requiresHumanApproval: false };
    checkKeys(record, ["kind", "summary", "risk", "requiresHumanApproval"], path, issues);
    if (record.kind !== "simulate" && record.kind !== "install-composition" && record.kind !== "update-composition" && record.kind !== "deploy") {
      issues.push(`${path}.kind is unsupported`);
    }
    if (record.risk !== "low" && record.risk !== "medium" && record.risk !== "high") issues.push(`${path}.risk is unsupported`);
    if (typeof record.requiresHumanApproval !== "boolean") issues.push(`${path}.requiresHumanApproval must be a boolean`);
    return {
      kind: record.kind as AgentAction["kind"],
      summary: boundedString(record.summary, `${path}.summary`, 1_000, issues) ?? "",
      risk: record.risk as AgentAction["risk"],
      requiresHumanApproval: record.requiresHumanApproval as boolean,
    };
  });
}
