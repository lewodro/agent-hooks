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

/**
 * Evaluates host-side hooks in stable priority order. Keep implementations
 * deterministic and bounded; async work, model calls, and signing belong in
 * separate services, never in transaction-critical hook evaluation.
 */
export class SolanaHookEngine {
  private readonly hooks: readonly SolanaHook[];

  constructor(hooks: readonly SolanaHook[]) {
    const ids = new Set<string>();
    for (const hook of hooks) {
      if (!hook.id.trim() || !hook.programId.trim()) throw new Error("Hook id and programId are required");
      if (!Number.isFinite(hook.priority)) throw new Error(`Invalid priority for hook ${hook.id}`);
      if (ids.has(hook.id)) throw new Error(`Duplicate hook id: ${hook.id}`);
      ids.add(hook.id);
    }
    this.hooks = [...hooks].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }

  run(event: SolanaLifecycleEvent): HookRun {
    const receipts: HookReceipt[] = [];
    for (const hook of this.hooks) {
      if (!hook.events.includes(event.kind)) {
        receipts.push({ hookId: hook.id, programId: hook.programId, decision: { kind: "accept" }, skipped: true });
        continue;
      }
      const decision = hook.evaluate(event);
      receipts.push({ hookId: hook.id, programId: hook.programId, decision, skipped: false });
      if (decision.kind === "reject") {
        return { accepted: false, receipts, rejection: { hookId: hook.id, reason: decision.reason } };
      }
    }
    return { accepted: true, receipts };
  }
}

/** Adapter seam for RPC/indexer integrations. Read-only implementations are recommended. */
export interface SolanaEventSource {
  getEvent(signature: string): Promise<SolanaLifecycleEvent | null>;
}
