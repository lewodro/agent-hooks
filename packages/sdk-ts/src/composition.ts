import type { LifecycleEventKind } from "@agent-hooks/marginfi-adapter";

export interface HookSpec {
  name: string;
  programId: string;
  priority: number;
  flags: HookFlagBits;
  config?: Record<string, unknown>;
}

export interface HookFlagBits {
  bits: number;
}

export const HOOK_FLAGS = {
  BeforeDeposit: 1 << 0,
  AfterDeposit: 1 << 1,
  BeforeBorrow: 1 << 2,
  AfterBorrow: 1 << 3,
  BeforeRepay: 1 << 4,
  AfterRepay: 1 << 5,
  BeforeLiquidate: 1 << 6,
  AfterLiquidate: 1 << 7,
  MutatePayload: 1 << 8,
  MayReject: 1 << 9,
  UsesOracle: 1 << 10,
  MutatesRate: 1 << 11,
} as const;

export type HookFlagName = keyof typeof HOOK_FLAGS;

export function flagsFrom(names: HookFlagName[]): HookFlagBits {
  let bits = 0;
  for (const n of names) bits |= HOOK_FLAGS[n];
  return { bits };
}

export function eventToFlag(kind: LifecycleEventKind): number {
  switch (kind) {
    case "beforeDeposit": return HOOK_FLAGS.BeforeDeposit;
    case "afterDeposit": return HOOK_FLAGS.AfterDeposit;
    case "beforeBorrow": return HOOK_FLAGS.BeforeBorrow;
    case "afterBorrow": return HOOK_FLAGS.AfterBorrow;
    case "beforeRepay": return HOOK_FLAGS.BeforeRepay;
    case "afterRepay": return HOOK_FLAGS.AfterRepay;
    case "beforeLiquidate": return HOOK_FLAGS.BeforeLiquidate;
    case "afterLiquidate": return HOOK_FLAGS.AfterLiquidate;
  }
}

export class Composition {
  private entries: HookSpec[] = [];

  add(spec: HookSpec): this {
    if (this.entries.length >= 8) {
      throw new Error("Composition is full (max 8 hooks per pool slot)");
    }
    this.entries.push(spec);
    this.entries.sort((a, b) => a.priority - b.priority);
    return this;
  }

  hooks(): readonly HookSpec[] {
    return [...this.entries];
  }

  size(): number {
    return this.entries.length;
  }

  eligibleFor(kind: LifecycleEventKind): HookSpec[] {
    const bit = eventToFlag(kind);
    return this.entries.filter((e) => (e.flags.bits & bit) !== 0);
  }
}
