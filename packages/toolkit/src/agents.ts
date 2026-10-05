import type { HookRun, SolanaLifecycleEvent } from "./solana.js";

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

/** In-memory reference store. Replace with an encrypted, durable store in production. */
export class MemoryExperienceStore implements ExperienceStore {
  private readonly records: AgentExperience[] = [];

  async append(experience: AgentExperience): Promise<void> {
    this.records.push(structuredClone(experience));
  }

  async search(query: ExperienceQuery): Promise<readonly AgentExperience[]> {
    const matches = this.records.filter((record) =>
      (query.kind === undefined || record.event.kind === query.kind) &&
      (query.programId === undefined || record.event.programId === query.programId) &&
      (query.tags === undefined || query.tags.every((tag) => record.tags.includes(tag))),
    );
    return matches.slice(-Math.max(1, query.limit ?? 20)).reverse().map((item) => structuredClone(item));
  }
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
