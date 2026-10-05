import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
  outcome?: HookFeedback["outcome"];
  hookProgramId?: string;
  tag?: string;
  since?: string;
  until?: string;
  /** Require a caller-labeled confirmed/finalized chain record with transaction and block identity. */
  verifiedOnly?: boolean;
  limit?: number;
}

/** Storage boundary. Implement with SQLite/Postgres, an event bus, or vector memory. */
export interface ExperienceStore {
  append(experience: Experience): Promise<void>;
  query(query: ExperienceQuery): Promise<Experience[]>;
}

export interface SequencedExperience {
  /** Monotonic storage order, independent of caller-provided event timestamps. */
  readonly sequence: bigint;
  readonly experience: Experience;
}

/** Optional durable catch-up interface for agents consuming records across restarts. */
export interface ExperienceFeedStore extends ExperienceStore {
  readAfter(sequence: bigint, limit?: number): Promise<SequencedExperience[]>;
}

const EVENT_KINDS = new Set<LifecycleEvent["kind"]>([
  "beforeDeposit", "afterDeposit", "beforeBorrow", "afterBorrow",
  "beforeRepay", "afterRepay", "beforeLiquidate", "afterLiquidate",
]);
const ADAPTERS = new Set<LifecycleEvent["adapter"]>(["marginfi", "kamino", "solend"]);
const MAX_ID_LENGTH = 256;
const MAX_EVENT_PAYLOAD_BYTES = 256;
const MAX_ORACLE_POINTS = 16;
const MAX_HOOKS = 8;
const MAX_TRACE_ENTRIES = 8;
const MAX_TAGS = 64;
const MAX_TAG_LENGTH = 128;

/** Validate persisted or caller-provided experiences at every storage boundary. */
export function validateExperience(value: unknown): asserts value is Experience {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new TypeError("experience must use schema version 1");
  }
  requireString(value.id, "experience id", MAX_ID_LENGTH);
  requireString(value.observedAt, "experience observedAt", 64);
  if (!Number.isFinite(Date.parse(value.observedAt))) {
    throw new TypeError("experience observedAt must be a valid date string");
  }
  if (!isRecord(value.event)) throw new TypeError("experience event must be an object");
  const event = value.event;
  if (!EVENT_KINDS.has(event.kind as LifecycleEvent["kind"])) {
    throw new TypeError("experience event kind is not supported");
  }
  if (!ADAPTERS.has(event.adapter as LifecycleEvent["adapter"])) {
    throw new TypeError("experience event adapter is not supported");
  }
  if (!Array.isArray(event.payload) || event.payload.length > MAX_EVENT_PAYLOAD_BYTES ||
    event.payload.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new RangeError(`event payload must contain at most ${MAX_EVENT_PAYLOAD_BYTES} bytes`);
  }
  if (!isRecord(event.position)) throw new TypeError("experience position must be an object");
  const position = event.position;
  requireString(position.owner, "position owner", 128);
  requireString(position.collateralMint, "collateral mint", 128);
  requireString(position.debtMint, "debt mint", 128);
  requireFiniteNonNegative(position.collateralAmount, "collateral amount");
  requireFiniteNonNegative(position.debtAmount, "debt amount");
  requireBasisPoints(position.ltvBps, "position LTV");
  requireBasisPoints(position.liquidationThresholdBps, "liquidation threshold");

  if (!isRecord(event.market)) throw new TypeError("experience market must be an object");
  const market = event.market;
  requireSafeNonNegativeInteger(market.slot, "market slot");
  requireSafeInteger(market.timestamp, "market timestamp");
  requireFiniteNonNegative(market.realisedVolBps, "realised volatility");
  requireBasisPoints(market.utilisationBps, "market utilisation");
  if (!Array.isArray(market.oraclePoints) || market.oraclePoints.length > MAX_ORACLE_POINTS) {
    throw new RangeError(`market must contain at most ${MAX_ORACLE_POINTS} oracle points`);
  }
  for (const [index, point] of market.oraclePoints.entries()) {
    if (!isRecord(point)) throw new TypeError(`oracle point ${index} must be an object`);
    requireString(point.mint, `oracle point ${index} mint`, 128);
    requireUnsignedBigInt(point.priceE8, `oracle point ${index} priceE8`, true);
    requireUnsignedBigInt(point.confidenceE8, `oracle point ${index} confidenceE8`);
    requireUnsignedBigInt(point.slot, `oracle point ${index} slot`);
  }

  if (!isRecord(value.feedback)) throw new TypeError("experience feedback must be an object");
  const feedback = value.feedback;
  requireString(feedback.compositionId, "feedback compositionId", MAX_ID_LENGTH);
  if (!Array.isArray(feedback.hookProgramIds) || feedback.hookProgramIds.length > MAX_HOOKS) {
    throw new RangeError(`feedback may contain at most ${MAX_HOOKS} hook IDs`);
  }
  for (const hookId of feedback.hookProgramIds) requireString(hookId, "hookProgramId", 128);
  if (typeof feedback.accepted !== "boolean" ||
    !["executed", "rejected", "skipped", "failed"].includes(String(feedback.outcome))) {
    throw new TypeError("experience feedback outcome or accepted flag is invalid");
  }
  if (feedback.reward !== undefined) requireFiniteNumber(feedback.reward, "feedback reward");
  if (feedback.rewardUnit !== undefined) requireString(feedback.rewardUnit, "feedback rewardUnit", 128);
  if (feedback.reward !== undefined && feedback.rewardUnit === undefined) {
    throw new TypeError("feedback rewardUnit is required when reward is set");
  }
  if (feedback.reward === undefined && feedback.rewardUnit !== undefined) {
    throw new TypeError("feedback rewardUnit requires a reward value");
  }
  if (feedback.reason !== undefined) requireString(feedback.reason, "feedback reason", 1_024, true);

  if (!isRecord(value.evidence)) throw new TypeError("experience evidence must be an object");
  const evidence = value.evidence;
  if (!["simulation", "operator", "chain", "unknown"].includes(String(evidence.channel)) ||
    !["unverified", "observed", "submitted", "confirmed", "finalized", "failed"].includes(String(evidence.status))) {
    throw new TypeError("experience evidence channel or status is invalid");
  }
  validateEvidence(evidence as unknown as ExecutionEvidence);

  if (!Array.isArray(value.trace)) throw new TypeError("experience trace must be an array");
  validateTrace(value.trace as HookTraceEntry[]);
  if (!Array.isArray(value.tags) || value.tags.length > MAX_TAGS) {
    throw new RangeError(`experience may contain at most ${MAX_TAGS} tags`);
  }
  for (const tag of value.tags) requireString(tag, "experience tag", MAX_TAG_LENGTH, true);
}

/** Return a validated experience as a deeply immutable object. */
export function freezeExperience(experience: Experience): Experience {
  validateExperience(experience);
  return deepFreeze(experience);
}

export class ExperienceIdConflictError extends Error {
  constructor(public readonly experienceId: string) {
    super(`experience ID ${experienceId} already exists with different content`);
    this.name = "ExperienceIdConflictError";
  }
}

/** Bounded in-process store for local agents, tests, and development. Not durable. */
export class MemoryExperienceStore implements ExperienceFeedStore {
  private readonly records = new Map<string, Experience>();
  private readonly sequences = new Map<string, bigint>();
  private nextSequence = 1n;

  constructor(private readonly maxRecords = 10_000) {
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 1_000_000) {
      throw new RangeError("maxRecords must be a safe integer between 1 and 1000000");
    }
  }

  async append(experience: Experience): Promise<void> {
    validateExperience(experience);
    const existing = this.records.get(experience.id);
    if (existing) {
      if (isDeepStrictEqual(existing, experience)) return;
      throw new ExperienceIdConflictError(experience.id);
    }

    this.records.set(experience.id, deepFreeze(structuredClone(experience)));
    this.sequences.set(experience.id, this.nextSequence++);
    if (this.records.size > this.maxRecords) {
      const oldest = this.records.keys().next();
      if (!oldest.done) {
        this.records.delete(oldest.value);
        this.sequences.delete(oldest.value);
      }
    }
  }

  async readAfter(sequence: bigint, limit = 100): Promise<SequencedExperience[]> {
    validateFeedCursor(sequence, limit);
    return [...this.records.entries()]
      .map(([id, experience]) => ({ sequence: this.sequences.get(id)!, experience }))
      .filter((record) => record.sequence > sequence)
      .sort((left, right) => left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : 0)
      .slice(0, limit);
  }

  async query(query: ExperienceQuery): Promise<Experience[]> {
    const [since, until] = validateQueryWindow(query);
    const requestedLimit = query.limit ?? 20;
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
      : 20;
    return [...this.records.values()]
      .filter((record) =>
        (query.adapter === undefined || record.event.adapter === query.adapter) &&
        (query.kind === undefined || record.event.kind === query.kind) &&
        (query.compositionId === undefined || record.feedback.compositionId === query.compositionId) &&
        (query.outcome === undefined || record.feedback.outcome === query.outcome) &&
        (query.hookProgramId === undefined || record.feedback.hookProgramIds.includes(query.hookProgramId)) &&
        (query.tag === undefined || record.tags.includes(query.tag)) &&
        (since === undefined || Date.parse(record.observedAt) >= since) &&
        (until === undefined || Date.parse(record.observedAt) <= until) &&
        (!query.verifiedOnly || isMarkedVerifiedChainOutcome(record.evidence)),
      )
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt))
      .slice(0, limit);
  }
}

export interface ExperienceSubscriptionOptions {
  /** Deliver only records labeled confirmed/finalized by a trusted chain observer. */
  verifiedOnly?: boolean;
}

export type ExperienceListener = (experience: Experience) => void | Promise<void>;

/** The record is already durable when notification fails; retry with the same ID. */
export class ExperienceNotificationError extends AggregateError {
  constructor(
    public readonly experienceId: string,
    errors: readonly unknown[],
  ) {
    super(errors, `experience ${experienceId} was stored but one or more subscribers failed`);
    this.name = "ExperienceNotificationError";
  }
}

export class AgentBrain {
  private readonly subscribers = new Map<ExperienceListener, ExperienceSubscriptionOptions>();

  constructor(private readonly store: ExperienceStore) {}

  /**
   * Subscribe to new durable experiences in this process. Delivery is awaited,
   * bounded to 64 listeners, and at-least-once when callers retry failed notifications.
   */
  subscribe(
    listener: ExperienceListener,
    options: ExperienceSubscriptionOptions = {},
  ): () => void {
    if (this.subscribers.size >= 64 && !this.subscribers.has(listener)) {
      throw new RangeError("AgentBrain supports at most 64 active subscribers");
    }
    this.subscribers.set(listener, { ...options });
    return () => this.subscribers.delete(listener);
  }

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
    validateExperience(experience);
    await this.store.append(experience);
    await this.notifySubscribers(experience);
    return experience;
  }

  /** Return prior feedback for a planner to use when proposing the next hook change. */
  async recall(query: ExperienceQuery = {}): Promise<Experience[]> {
    validateQueryWindow(query);
    const requestedLimit = query.limit ?? 20;
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
      : 20;
    const records = await this.store.query({ ...query, limit });
    return query.verifiedOnly
      ? records.filter((record) => isMarkedVerifiedChainOutcome(record.evidence)).slice(0, limit)
      : records;
  }

  /** Read durable records after a persisted sequence; works with feed-capable stores. */
  async readAfter(sequence: bigint, limit = 100): Promise<SequencedExperience[]> {
    validateFeedCursor(sequence, limit);
    const store = this.store as ExperienceStore & Partial<ExperienceFeedStore>;
    if (typeof store.readAfter !== "function") {
      throw new TypeError("the configured ExperienceStore does not support sequenced replay");
    }
    return store.readAfter(sequence, limit);
  }

  private async notifySubscribers(experience: Experience): Promise<void> {
    const notifications = [...this.subscribers].map(async ([listener, options]) => {
      if (options.verifiedOnly && !isMarkedVerifiedChainOutcome(experience.evidence)) return;
      await listener(experience);
    });
    const results = await Promise.allSettled(notifications);
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) throw new ExperienceNotificationError(experience.id, errors);
  }
}

function validateQueryWindow(query: ExperienceQuery): [number | undefined, number | undefined] {
  const since = query.since === undefined ? undefined : Date.parse(query.since);
  const until = query.until === undefined ? undefined : Date.parse(query.until);
  if (since !== undefined && !Number.isFinite(since)) throw new TypeError("query since must be a valid date string");
  if (until !== undefined && !Number.isFinite(until)) throw new TypeError("query until must be a valid date string");
  if (since !== undefined && until !== undefined && since > until) {
    throw new RangeError("query since must be earlier than or equal to until");
  }
  return [since, until];
}

export function validateFeedCursor(sequence: bigint, limit: number): void {
  if (typeof sequence !== "bigint" || sequence < 0n) {
    throw new RangeError("experience feed sequence must be a non-negative bigint");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new RangeError("experience feed limit must be an integer between 1 and 500");
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
  if (evidence.network !== undefined) requireString(evidence.network, "evidence network", 128);
  if (evidence.transactionId !== undefined) requireString(evidence.transactionId, "evidence transactionId", 256);
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
  if (trace.length > MAX_TRACE_ENTRIES) {
    throw new RangeError(`trace exceeds the maximum of ${MAX_TRACE_ENTRIES} hook entries`);
  }
  for (const entry of trace) {
    if (!isRecord(entry)) throw new TypeError("trace entries must be objects");
    requireString(entry.hookId, "trace hookId", 128);
    if (!["accepted", "accepted_with", "rejected", "skipped", "failed"].includes(entry.decision)) {
      throw new TypeError("trace decision is invalid");
    }
    if (entry.reason !== undefined && (typeof entry.reason !== "string" || entry.reason.length > 1_024)) {
      throw new RangeError("trace reason exceeds 1024 characters");
    }
    if (entry.effects !== undefined && !Array.isArray(entry.effects)) {
      throw new TypeError("trace effects must be an array");
    }
    if ((entry.effects?.length ?? 0) > 16) {
      throw new RangeError("a trace entry may contain at most 16 effects");
    }
    for (const effect of entry.effects ?? []) {
      if (!isRecord(effect)) throw new TypeError("trace effects must be objects");
      requireString(effect.kind, "trace effect kind", 128);
      if (effect.numericValue !== undefined && !Number.isFinite(effect.numericValue)) {
        throw new TypeError("trace effect numericValue must be finite");
      }
      if (effect.reference !== undefined) requireString(effect.reference, "trace effect reference", 256, true);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string, maximum: number, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && !value.trim())) {
    throw new TypeError(`${field} must be a${allowEmpty ? "" : " non-empty"} string of at most ${maximum} characters`);
  }
}

function requireFiniteNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${field} must be finite`);
}

function requireFiniteNonNegative(value: unknown, field: string): asserts value is number {
  requireFiniteNumber(value, field);
  if (value < 0) throw new RangeError(`${field} must be non-negative`);
}

function requireSafeInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new TypeError(`${field} must be a safe integer`);
}

function requireSafeNonNegativeInteger(value: unknown, field: string): asserts value is number {
  requireSafeInteger(value, field);
  if (value < 0) throw new RangeError(`${field} must be non-negative`);
}

function requireBasisPoints(value: unknown, field: string): asserts value is number {
  requireSafeInteger(value, field);
  if (value < 0 || value > 10_000) throw new RangeError(`${field} must be between 0 and 10000 bps`);
}

function requireUnsignedBigInt(value: unknown, field: string, requirePositive = false): asserts value is bigint {
  if (typeof value !== "bigint" || value < 0n || (requirePositive && value === 0n)) {
    throw new TypeError(`${field} must be a ${requirePositive ? "positive" : "non-negative"} bigint`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
