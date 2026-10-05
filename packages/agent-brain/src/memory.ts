import { randomUUID } from "node:crypto";
import type { LifecycleEvent } from "@agent-hooks/sdk";

/** Observable outcome of running a composition against one lifecycle event. */
export interface HookFeedback {
  compositionId: string;
  hookProgramIds: string[];
  accepted: boolean;
  outcome: "executed" | "rejected" | "skipped" | "failed";
  reward?: number;
  reason?: string;
}

/** One immutable experience record, suitable for durable stores or vector indexing. */
export interface Experience {
  id: string;
  observedAt: string;
  event: LifecycleEvent;
  feedback: HookFeedback;
  tags: string[];
}

export interface ExperienceQuery {
  adapter?: LifecycleEvent["adapter"];
  kind?: LifecycleEvent["kind"];
  compositionId?: string;
  limit?: number;
}

/** Storage boundary. Implement with SQLite/Postgres, an event bus, or vector memory. */
export interface ExperienceStore {
  append(experience: Experience): Promise<void>;
  query(query: ExperienceQuery): Promise<Experience[]>;
}

export class AgentBrain {
  constructor(private readonly store: ExperienceStore) {}

  async observe(input: Omit<Experience, "id" | "observedAt"> & {
    id?: string;
    observedAt?: string;
  }): Promise<Experience> {
    const experience: Experience = {
      ...input,
      id: input.id ?? randomUUID(),
      observedAt: input.observedAt ?? new Date().toISOString(),
      tags: [...new Set(input.tags)],
    };
    await this.store.append(experience);
    return experience;
  }

  /** Return prior feedback for a planner to use when proposing the next hook change. */
  recall(query: ExperienceQuery = {}): Promise<Experience[]> {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 200);
    return this.store.query({ ...query, limit });
  }
}
