/** Stable, provider-neutral representation of an observed Solana action. */
export interface SolanaLifecycleEvent {
  signature: string;
  slot: number;
  timestamp: number;
  kind: string;
  programId: string;
  market?: string;
  actor?: string;
  data: Readonly<Record<string, unknown>>;
}

export type HookDecision =
  | { kind: "accept" }
  | { kind: "accept-with"; effects: readonly HookEffect[] }
  | { kind: "reject"; reason: string };

/** Effects are proposals for the host; this toolkit never submits them. */
export type HookEffect =
  | { kind: "limit"; field: string; value: number }
  | { kind: "delay"; slots: number }
  | { kind: "instruction"; programId: string; dataBase64: string };

export interface SolanaHook {
  id: string;
  programId: string;
  priority: number;
  events: readonly string[];
  evaluate(event: SolanaLifecycleEvent): HookDecision;
}

export interface HookReceipt {
  hookId: string;
  programId: string;
  decision: HookDecision;
  skipped: boolean;
}

export interface HookRun {
  accepted: boolean;
  receipts: readonly HookReceipt[];
  rejection?: { hookId: string; reason: string };
}

const MAX_HOOKS = 32;
const MAX_EFFECTS_PER_HOOK = 16;
const MAX_DELAY_SLOTS = 1_000_000;
const MAX_INSTRUCTION_DATA_BASE64_LENGTH = 8_192;

/**
 * Evaluates host-side hooks in stable priority order. Keep implementations
 * deterministic and bounded; async work, model calls, and signing belong in
 * separate services, never in transaction-critical hook evaluation.
 */
export class SolanaHookEngine {
  private readonly hooks: readonly SolanaHook[];

  constructor(hooks: readonly SolanaHook[]) {
    if (hooks.length > MAX_HOOKS) throw new Error(`At most ${MAX_HOOKS} hooks may be evaluated together`);
    const ids = new Set<string>();
    for (const hook of hooks) {
      if (!hook.id.trim() || !hook.programId.trim()) throw new Error("Hook id and programId are required");
      if (!Number.isSafeInteger(hook.priority)) throw new Error(`Invalid priority for hook ${hook.id}`);
      if (hook.events.length === 0 || hook.events.some((event) => !event.trim())) {
        throw new Error(`Hook ${hook.id} must declare at least one lifecycle event`);
      }
      if (ids.has(hook.id)) throw new Error(`Duplicate hook id: ${hook.id}`);
      ids.add(hook.id);
    }
    this.hooks = [...hooks].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }

  run(event: SolanaLifecycleEvent): HookRun {
    validateLifecycleEvent(event);
    const receipts: HookReceipt[] = [];
    for (const hook of this.hooks) {
      if (!hook.events.includes(event.kind)) {
        receipts.push({ hookId: hook.id, programId: hook.programId, decision: { kind: "accept" }, skipped: true });
        continue;
      }
      let decision: HookDecision;
      try {
        decision = hook.evaluate(event);
        validateHookDecision(decision);
      } catch {
        const failed: HookDecision = { kind: "reject", reason: "hook evaluation failed" };
        receipts.push({ hookId: hook.id, programId: hook.programId, decision: failed, skipped: false });
        return { accepted: false, receipts, rejection: { hookId: hook.id, reason: failed.reason } };
      }
      receipts.push({ hookId: hook.id, programId: hook.programId, decision, skipped: false });
      if (decision.kind === "reject") {
        return { accepted: false, receipts, rejection: { hookId: hook.id, reason: decision.reason } };
      }
    }
    return { accepted: true, receipts };
  }
}

function validateLifecycleEvent(event: SolanaLifecycleEvent): void {
  if (!event.signature.trim() || !event.programId.trim() || !event.kind.trim()) {
    throw new TypeError("Lifecycle event signature, programId, and kind are required");
  }
  if (!Number.isSafeInteger(event.slot) || event.slot < 0) {
    throw new TypeError("Lifecycle event slot must be a non-negative safe integer");
  }
  if (!Number.isFinite(event.timestamp) || event.timestamp < 0) {
    throw new TypeError("Lifecycle event timestamp must be non-negative and finite");
  }
  if (event.data === null || typeof event.data !== "object" || Array.isArray(event.data)) {
    throw new TypeError("Lifecycle event data must be an object");
  }
}

function validateHookDecision(decision: HookDecision): void {
  if (decision.kind === "accept") return;
  if (decision.kind === "reject") {
    if (!decision.reason.trim()) throw new TypeError("Rejected hook decisions require a reason");
    return;
  }
  if (decision.effects.length > MAX_EFFECTS_PER_HOOK) {
    throw new RangeError(`Hook decision exceeds ${MAX_EFFECTS_PER_HOOK} effects`);
  }
  for (const effect of decision.effects) {
    if (effect.kind === "limit") {
      if (!effect.field.trim() || !Number.isFinite(effect.value)) throw new TypeError("Invalid limit effect");
    } else if (effect.kind === "delay") {
      if (!Number.isSafeInteger(effect.slots) || effect.slots < 0 || effect.slots > MAX_DELAY_SLOTS) {
        throw new RangeError(`Delay effect slots must be between 0 and ${MAX_DELAY_SLOTS}`);
      }
    } else if (!effect.programId.trim() || effect.dataBase64.length > MAX_INSTRUCTION_DATA_BASE64_LENGTH) {
      throw new TypeError("Invalid instruction effect");
    }
  }
}

/** Adapter seam for RPC/indexer integrations. Read-only implementations are recommended. */
export interface SolanaEventSource {
  getEvent(signature: string): Promise<SolanaLifecycleEvent | null>;
}
