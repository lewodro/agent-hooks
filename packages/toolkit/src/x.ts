import { createHash, randomUUID } from "node:crypto";

import type { AgentExperience } from "./agents.js";

const MAX_EXPERIENCES_PER_POST = 100;
const MAX_POST_LENGTH = 280;
const DEFAULT_MAX_DRAFTS = 10_000;

export interface XPostDraft {
  id: string;
  date: string;
  text: string;
  sourceExperienceIds: readonly string[];
  createdAt: number;
  status: "draft" | "approved" | "publishing" | "publish-unknown" | "published" | "rejected";
  approvedBy?: string;
  approvedAt?: number;
  contentFingerprint: string;
  postId?: string;
}

export interface XPostWriter {
  write(input: { date: string; experiences: readonly AgentExperience[] }): Promise<string>;
}

export interface XPublisher {
  publish(text: string, options?: { idempotencyKey: string }): Promise<{ postId: string }>;
}

/** Drafts one evidence-linked daily post; publication always requires approval. */
export class DailyXWorkflow {
  private readonly drafts = new Map<string, XPostDraft>();

  constructor(
    private readonly writer: XPostWriter,
    private readonly publisher?: XPublisher,
    private readonly maxDrafts = DEFAULT_MAX_DRAFTS,
  ) {
    if (!Number.isSafeInteger(maxDrafts) || maxDrafts < 1 || maxDrafts > 1_000_000) {
      throw new RangeError("maxDrafts must be a safe integer between 1 and 1000000");
    }
  }

  async draft(date: string, experiences: readonly AgentExperience[]): Promise<XPostDraft> {
    validateDate(date);
    if (experiences.length > MAX_EXPERIENCES_PER_POST) {
      throw new RangeError(`At most ${MAX_EXPERIENCES_PER_POST} experiences may be summarized in one post`);
    }
    const sourceExperienceIds = experiences.map((item) => item.id);
    if (sourceExperienceIds.some((id) => !id.trim()) || new Set(sourceExperienceIds).size !== sourceExperienceIds.length) {
      throw new TypeError("Source experience IDs must be non-empty and unique");
    }
    const activeDraft = [...this.drafts.values()].find((draft) => draft.date === date && draft.status !== "rejected");
    if (activeDraft) throw new Error(`A non-rejected X draft already exists for ${date}`);
    if (this.drafts.size >= this.maxDrafts) {
      throw new Error(`X workflow reached its ${this.maxDrafts} draft capacity; persist or archive reviewed history`);
    }
    const text = (await this.writer.write({ date, experiences })).trim();
    if (!text) throw new Error("X post writer returned an empty draft");
    if ([...text].length > MAX_POST_LENGTH) throw new Error(`Draft exceeds ${MAX_POST_LENGTH} code points`);
    const id = randomUUID();
    const draft: XPostDraft = {
      id,
      date,
      text,
      sourceExperienceIds,
      createdAt: Date.now(),
      status: "draft",
      contentFingerprint: fingerprint({ date, text, sourceExperienceIds }),
    };
    this.drafts.set(draft.id, draft);
    return structuredClone(draft);
  }

  approve(id: string, approver: string): XPostDraft {
    const draft = this.requireDraft(id, "draft");
    if (!approver.trim()) throw new Error("An authenticated approver identity is required");
    draft.status = "approved";
    draft.approvedBy = approver.trim();
    draft.approvedAt = Date.now();
    return structuredClone(draft);
  }

  reject(id: string, reviewer: string): XPostDraft {
    const draft = this.requireDraft(id, "draft");
    if (!reviewer.trim()) throw new Error("A reviewer identity is required");
    draft.status = "rejected";
    draft.approvedBy = reviewer.trim();
    draft.approvedAt = Date.now();
    return structuredClone(draft);
  }

  async publish(id: string): Promise<XPostDraft> {
    const draft = this.requireDraft(id, "approved");
    if (!this.publisher) throw new Error("No X publisher configured; copy this approved draft for manual posting");
    if (draft.contentFingerprint !== fingerprint({
      date: draft.date,
      text: draft.text,
      sourceExperienceIds: draft.sourceExperienceIds,
    })) {
      throw new Error("Approved X draft content changed after review");
    }
    // Reserve the transition before awaiting network I/O so concurrent calls cannot double-publish.
    draft.status = "publishing";
    let result: { postId: string };
    try {
      result = await this.publisher.publish(draft.text, { idempotencyKey: draft.id });
    } catch (cause) {
      draft.status = "publish-unknown";
      throw new XPublicationUncertainError(draft.id, cause);
    }
    if (!result.postId?.trim()) {
      draft.status = "publish-unknown";
      throw new XPublicationUncertainError(draft.id, new Error("publisher returned no post ID"));
    }
    draft.postId = result.postId;
    draft.status = "published";
    return structuredClone(draft);
  }

  get(id: string): XPostDraft | undefined {
    const draft = this.drafts.get(id);
    return draft ? structuredClone(draft) : undefined;
  }

  private requireDraft(id: string, status: "draft" | "approved"): XPostDraft {
    const draft = this.drafts.get(id);
    if (!draft || draft.status !== status) throw new Error(`Post ${id} must exist with status ${status}`);
    return draft;
  }
}

export class XPublicationUncertainError extends Error {
  constructor(public readonly draftId: string, cause: unknown) {
    super(`X publication outcome for draft ${draftId} is unknown; reconcile with the provider before retrying`, { cause });
    this.name = "XPublicationUncertainError";
  }
}

function validateDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) {
    throw new TypeError("X draft date must be a valid YYYY-MM-DD UTC date");
  }
}

function fingerprint(value: { date: string; text: string; sourceExperienceIds: readonly string[] }): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
