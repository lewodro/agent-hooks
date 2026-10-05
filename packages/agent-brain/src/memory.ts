import { randomUUID } from "node:crypto";
import type { LifecycleEvent } from "@agent-hooks/sdk";

export type EvidenceChannel = "simulation" | "operator" | "chain" | "unknown";
export type EvidenceStatus =
  | "unverified"
  | "observed"
  | "submitted"
  | "confirmed"
  | "finalized"
  | "failed";

/** Caller-reported provenance. The brain records labels; it does not verify RPC data. */
export interface ExecutionEvidence {
  readonly channel: EvidenceChannel;
  readonly status: EvidenceStatus;
  readonly network?: string;
  readonly transactionId?: string;
  readonly slot?: number;
  readonly blockHeight?: number;
}

export type HookTraceDecision = "accepted" | "accepted_with" | "rejected" | "skipped" | "failed";

/** Bounded, serializable per-hook result suitable for audit and replay. */
export interface HookTraceEntry {
  readonly hookId: string;
  readonly decision: HookTraceDecision;
  readonly reason?: string;
  readonly effects?: readonly {
    readonly kind: string;
    readonly numericValue?: number;
    readonly reference?: string;
  }[];
}

/** Observable outcome of running a composition against one lifecycle event. */
export interface HookFeedback {
  readonly compositionId: string;
  readonly hookProgramIds: readonly string[];
  readonly accepted: boolean;
  readonly outcome: "executed" | "rejected" | "skipped" | "failed";
  readonly reward?: number;
  /** Required with reward so planners do not mix incompatible scales. */
  readonly rewardUnit?: string;
  readonly reason?: string;
}

/** One immutable experience record, suitable for durable stores or vector indexing. */
export interface Experience {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly observedAt: string;
  readonly event: LifecycleEvent;
  readonly feedback: HookFeedback;
  readonly evidence: ExecutionEvidence;
  readonly trace: readonly HookTraceEntry[];
  readonly tags: readonly string[];
}

export interface ExperienceQuery {
  adapter?: LifecycleEvent["adapter"];
  kind?: LifecycleEvent["kind"];
  compositionId?: string;
  /** Require a caller-labeled confirmed/finalized chain record with transaction and block identity. */
  verifiedOnly?: boolean;
  limit?: number;
}

/** Storage boundary. Implement with SQLite/Postgres, an event bus, or vector memory. */
export interface ExperienceStore {
  append(experience: Experience): Promise<void>;
  query(query: ExperienceQuery): Promise<Experience[]>;
}

export class AgentBrain {
  constructor(private readonly store: ExperienceStore) {}

  async observe(input: Omit<Experience, "schemaVersion" | "id" | "observedAt" | "evidence" | "trace"> & {
    id?: string;
    observedAt?: string;
    evidence?: ExecutionEvidence;
    trace?: readonly HookTraceEntry[];
  }): Promise<Experience> {
    const evidence = input.evidence ?? { channel: "unknown", status: "unverified" };
    validateEvidence(evidence);
    if (input.feedback.reward !== undefined && !Number.isFinite(input.feedback.reward)) {
      throw new TypeError("feedback reward must be a finite number");
    }
    if (input.feedback.reward !== undefined && !input.feedback.rewardUnit?.trim()) {
      throw new TypeError("feedback rewardUnit is required when reward is set");
    }
    if (input.feedback.reward === undefined && input.feedback.rewardUnit !== undefined) {
      throw new TypeError("feedback rewardUnit requires a reward value");
    }
    if (!input.feedback.compositionId.trim()) {
      throw new TypeError("feedback compositionId must not be empty");
    }
    if (input.feedback.hookProgramIds.some((programId) => !programId.trim())) {
      throw new TypeError("hookProgramIds must not contain empty IDs");
    }
    const trace = input.trace ?? [];
    validateTrace(trace);
    const observedAt = input.observedAt ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(observedAt))) {
      throw new TypeError("observedAt must be a valid date string");
    }
    const id = input.id ?? randomUUID();
    if (!id.trim()) throw new TypeError("experience id must not be empty");
    const experience = deepFreeze({
      schemaVersion: 1 as const,
      ...input,
      id,
      observedAt,
      evidence: { ...evidence },
      trace: trace.map((entry) =>
        entry.effects === undefined
          ? { ...entry }
          : { ...entry, effects: entry.effects.map((effect) => ({ ...effect })) },
      ),
      event: structuredClone(input.event),
      feedback: {
        ...input.feedback,
        hookProgramIds: [...new Set(input.feedback.hookProgramIds)],
      },
      tags: [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))],
    });
    await this.store.append(experience);
    return experience;
  }

  /** Return prior feedback for a planner to use when proposing the next hook change. */
  async recall(query: ExperienceQuery = {}): Promise<Experience[]> {
    const requestedLimit = query.limit ?? 20;
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
      : 20;
    const records = await this.store.query({ ...query, limit });
    return query.verifiedOnly
      ? records.filter((record) => isMarkedVerifiedChainOutcome(record.evidence)).slice(0, limit)
      : records;
  }
}

/** True only for evidence labeled as a confirmed/finalized chain result with identifiers. */
export function isMarkedVerifiedChainOutcome(evidence: ExecutionEvidence): boolean {
  return (
    evidence.channel === "chain" &&
    (evidence.status === "confirmed" || evidence.status === "finalized") &&
    Boolean(evidence.network?.trim()) &&
    Boolean(evidence.transactionId?.trim()) &&
    ((evidence.slot !== undefined && Number.isSafeInteger(evidence.slot) && evidence.slot >= 0) ||
      (evidence.blockHeight !== undefined && Number.isSafeInteger(evidence.blockHeight) && evidence.blockHeight >= 0))
  );
}

function validateEvidence(evidence: ExecutionEvidence): void {
  if (evidence.network !== undefined && !evidence.network.trim()) {
    throw new TypeError("evidence network must not be empty");
  }
  if (evidence.transactionId !== undefined && !evidence.transactionId.trim()) {
    throw new TypeError("evidence transactionId must not be empty");
  }
  for (const height of [evidence.slot, evidence.blockHeight]) {
    if (height !== undefined && (!Number.isSafeInteger(height) || height < 0)) {
      throw new TypeError("evidence slot and blockHeight must be non-negative safe integers");
    }
  }
  if ((evidence.status === "confirmed" || evidence.status === "finalized") && evidence.channel !== "chain") {
    throw new TypeError("confirmed/finalized evidence must come from the chain channel");
  }
  if (
    (evidence.status === "confirmed" || evidence.status === "finalized") &&
    (!evidence.network?.trim() ||
      !evidence.transactionId?.trim() ||
      !(
        (evidence.slot !== undefined && Number.isSafeInteger(evidence.slot) && evidence.slot >= 0) ||
        (evidence.blockHeight !== undefined && Number.isSafeInteger(evidence.blockHeight) && evidence.blockHeight >= 0)
      ))
  ) {
    throw new TypeError("confirmed/finalized evidence must include network, transactionId, and slot or blockHeight");
  }
}

function validateTrace(trace: readonly HookTraceEntry[]): void {
  if (trace.length > 64) throw new RangeError("trace exceeds the maximum of 64 hook entries");
  for (const entry of trace) {
    if (!entry.hookId.trim()) throw new TypeError("trace hookId must not be empty");
    if (entry.reason !== undefined && entry.reason.length > 1_024) {
      throw new RangeError("trace reason exceeds 1024 characters");
    }
    if ((entry.effects?.length ?? 0) > 16) {
      throw new RangeError("a trace entry may contain at most 16 effects");
    }
    for (const effect of entry.effects ?? []) {
      if (!effect.kind.trim()) throw new TypeError("trace effect kind must not be empty");
      if (effect.numericValue !== undefined && !Number.isFinite(effect.numericValue)) {
        throw new TypeError("trace effect numericValue must be finite");
      }
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
