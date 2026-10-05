import type { AgentExperience } from "./agents.js";

export interface XPostDraft {
  id: string;
  text: string;
  sourceExperienceIds: readonly string[];
  createdAt: number;
  status: "draft" | "approved" | "published" | "rejected";
  postId?: string;
}

export interface XPostWriter {
  write(input: { date: string; experiences: readonly AgentExperience[] }): Promise<string>;
}

export interface XPublisher {
  publish(text: string): Promise<{ postId: string }>;
}

/** Drafts one evidence-linked daily post; publication always requires approval. */
export class DailyXWorkflow {
  private readonly drafts = new Map<string, XPostDraft>();

  constructor(
    private readonly writer: XPostWriter,
    private readonly publisher?: XPublisher,
  ) {}

  async draft(date: string, experiences: readonly AgentExperience[]): Promise<XPostDraft> {
    const text = (await this.writer.write({ date, experiences })).trim();
    if (!text) throw new Error("X post writer returned an empty draft");
    if (text.length > 280) throw new Error("Draft exceeds 280 characters");
    const draft: XPostDraft = {
      id: crypto.randomUUID(),
      text,
      sourceExperienceIds: experiences.map((item) => item.id),
      createdAt: Date.now(),
      status: "draft",
    };
    this.drafts.set(draft.id, draft);
    return structuredClone(draft);
  }

  approve(id: string): XPostDraft {
    const draft = this.requireDraft(id, "draft");
    draft.status = "approved";
    return structuredClone(draft);
  }

  reject(id: string): XPostDraft {
    const draft = this.requireDraft(id, "draft");
    draft.status = "rejected";
    return structuredClone(draft);
  }

  async publish(id: string): Promise<XPostDraft> {
    const draft = this.requireDraft(id, "approved");
    if (!this.publisher) throw new Error("No X publisher configured; copy this approved draft for manual posting");
    const result = await this.publisher.publish(draft.text);
    draft.postId = result.postId;
    draft.status = "published";
    return structuredClone(draft);
  }

  get(id: string): XPostDraft | undefined {
    const draft = this.drafts.get(id);
    return draft ? structuredClone(draft) : undefined;
  }

  private requireDraft(id: string, status: XPostDraft["status"]): XPostDraft {
    const draft = this.drafts.get(id);
    if (!draft || draft.status !== status) throw new Error(`Post ${id} must exist with status ${status}`);
    return draft;
  }
}
