import type { HookRun, SolanaLifecycleEvent } from "./solana.js";
import { isDeepStrictEqual } from "node:util";

export interface AgentExperience {
  id: string;
  event: SolanaLifecycleEvent;
  run: HookRun;
  outcome: { label: string; reward?: number; notes?: string };
  recordedAt: number;
  tags: readonly string[];
}

export interface ExperienceQuery {
  kind?: string;
  programId?: string;
  tags?: readonly string[];
  limit?: number;
}

export interface ExperienceStore {
  append(experience: AgentExperience): Promise<void>;
  search(query: ExperienceQuery): Promise<readonly AgentExperience[]>;
}

export class ExperienceIdConflictError extends Error {
  constructor(public readonly experienceId: string) {
    super(`Experience ${experienceId} already exists with different content`);
    this.name = "ExperienceIdConflictError";
  }
}

/**
 * Bounded in-memory reference store for local development. Appends are
 * idempotent by experience ID and return immutable snapshots. Replace with an
 * encrypted, durable store in production.
 */
export class MemoryExperienceStore implements ExperienceStore {
  private readonly records = new Map<string, AgentExperience>();

  constructor(private readonly maxRecords = 10_000) {
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 1_000_000) {
      throw new RangeError("maxRecords must be a safe integer between 1 and 1000000");
    }
  }

  async append(experience: AgentExperience): Promise<void> {
    validateExperience(experience);
    const existing = this.records.get(experience.id);
    if (existing) {
      if (isDeepStrictEqual(existing, experience)) return;
      throw new ExperienceIdConflictError(experience.id);
    }
    this.records.set(experience.id, structuredClone(experience));
    if (this.records.size > this.maxRecords) {
      const oldest = this.records.keys().next();
      if (!oldest.done) this.records.delete(oldest.value);
    }
  }

  async search(query: ExperienceQuery): Promise<readonly AgentExperience[]> {
    const requestedLimit = query.limit ?? 20;
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
      : 20;
    const matches = [...this.records.values()].filter((record) =>
      (query.kind === undefined || record.event.kind === query.kind) &&
      (query.programId === undefined || record.event.programId === query.programId) &&
      (query.tags === undefined || query.tags.every((tag) => record.tags.includes(tag))),
    );
    return matches
      .sort((left, right) => right.recordedAt - left.recordedAt)
      .slice(0, limit)
      .map((item) => structuredClone(item));
  }
}

function validateExperience(experience: AgentExperience): void {
  if (!experience.id.trim()) throw new TypeError("Experience id is required");
  if (!Number.isFinite(experience.recordedAt) || experience.recordedAt < 0) {
    throw new TypeError("Experience recordedAt must be a non-negative finite timestamp");
  }
  if (!experience.outcome.label.trim()) throw new TypeError("Experience outcome label is required");
  if (experience.outcome.reward !== undefined && !Number.isFinite(experience.outcome.reward)) {
    throw new TypeError("Experience outcome reward must be finite when present");
  }
  if (experience.tags.some((tag) => !tag.trim())) throw new TypeError("Experience tags must not contain empty values");
}

export interface AgentProposal<T = unknown> {
  id: string;
  objective: string;
  createdAt: number;
  basedOnExperienceIds: readonly string[];
  payload: T;
  status: "draft" | "reviewed" | "rejected";
}

export interface AgentPlanner<T = unknown> {
  propose(input: { objective: string; experience: readonly AgentExperience[] }): Promise<T>;
}

/** Builds proposals from recorded outcomes; it does not train a model or execute proposals. */
export class LearningAgent<T = unknown> {
  constructor(private readonly store: ExperienceStore, private readonly planner: AgentPlanner<T>) {}

  async propose(objective: string, query: ExperienceQuery = {}): Promise<AgentProposal<T>> {
    if (!objective.trim()) throw new Error("A proposal objective is required");
    const experience = await this.store.search(query);
    return {
      id: crypto.randomUUID(),
      objective,
      createdAt: Date.now(),
      basedOnExperienceIds: experience.map((item) => item.id),
      payload: await this.planner.propose({ objective, experience }),
      status: "draft",
    };
  }
}
