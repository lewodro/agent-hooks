import { Command } from "commander";
import kleur from "kleur";
import { Connection, PublicKey } from "@solana/web3.js";

const AGENT_HOOKS_EXECUTOR_ID = "5yNMqcyZsGQJk4xvw4jjvoRBSnGs8mgramEa3HQe5faD";

const EVENT_KIND_LABEL: Record<number, string> = {
  0: "beforeDeposit",
  1: "afterDeposit",
  2: "beforeBorrow",
  3: "afterBorrow",
  4: "beforeRepay",
  5: "afterRepay",
  6: "beforeLiquidate",
  7: "afterLiquidate",
};

interface ParsedReceipt {
  signature: string;
  slot: number;
  blockTime: number | null;
  // CompositionExecuted (aggregate)
  event_kind?: number;
  hook_count_eligible?: number;
  hook_count_skipped?: number;
  composition?: string;
  pool?: string;
  // HookRan entries (v0.1.3 — per eligible hook)
  hook_runs?: Array<{
    hook_program: string;
    priority: number;
    flags_bits: number;
    decision: number;
    side_effect_kind: number;
    side_effect_payload: bigint;
  }>;
}

// HookRan struct (v0.1.3, 8-byte discriminator prefix):
// composition(32) + pool(32) + event_kind(u8) + hook_program(32) +
// priority(u16) + flags_bits(u16) + decision(u8) + side_effect_kind(u8) +
// side_effect_payload(u64) + timestamp(i64)
// = 8 + 32 + 32 + 1 + 32 + 2 + 2 + 1 + 1 + 8 + 8 = 127 bytes
const HOOK_RAN_LEN = 127;
// CompositionExecuted struct:
// composition(32) + pool(32) + event_kind(u8) + position_owner(32) +
// adapter(u8) + hook_count_eligible(u8) + hook_count_skipped(u8) + timestamp(i64)
// = 8 + 32 + 32 + 1 + 32 + 1 + 1 + 1 + 8 = 116 bytes
const COMP_EXEC_LEN = 116;

function parseExecutorLogs(logs: string[]): Partial<ParsedReceipt> {
  // The executor emits two events via Anchor's `emit!`: CompositionExecuted
  // (aggregate, since v0.1.0) and HookRan (per eligible entry, since v0.1.3).
  // Anchor prints them as "Program data: <base64>" lines. We pull both
  // shapes off by length-matching; full borsh decode lives in @agent-hooks/sdk.
  const out: Partial<ParsedReceipt> = { hook_runs: [] };
  for (const line of logs) {
    if (!line.includes("Program data:")) continue;
    const b64 = line.split("Program data:")[1]?.trim();
    if (!b64) continue;
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, "base64");
    } catch {
      continue;
    }
    if (buf.length === COMP_EXEC_LEN) {
      out.composition = new PublicKey(buf.subarray(8, 40)).toBase58();
      out.pool = new PublicKey(buf.subarray(40, 72)).toBase58();
      out.event_kind = buf[72];
      out.hook_count_eligible = buf[106];
      out.hook_count_skipped = buf[107];
    } else if (buf.length === HOOK_RAN_LEN) {
      const hookProgram = new PublicKey(buf.subarray(8 + 32 + 32 + 1, 8 + 32 + 32 + 1 + 32)).toBase58();
      const off = 8 + 32 + 32 + 1 + 32;
      const priority = buf.readUInt16LE(off);
      const flags_bits = buf.readUInt16LE(off + 2);
      const decision = buf[off + 4]!;
      const side_effect_kind = buf[off + 5]!;
      const side_effect_payload = buf.readBigUInt64LE(off + 6);
      out.hook_runs!.push({
        hook_program: hookProgram,
        priority,
        flags_bits,
        decision,
        side_effect_kind,
        side_effect_payload,
      });
      // also fill composition / pool / event_kind from the first HookRan if
      // CompositionExecuted is missing (older firmwares or partial logs).
      if (!out.composition) {
        out.composition = new PublicKey(buf.subarray(8, 40)).toBase58();
        out.pool = new PublicKey(buf.subarray(40, 72)).toBase58();
        out.event_kind = buf[72];
      }
    }
  }
  return out;
}

const DECISION_LABEL: Record<number, string> = {
  0: "Accept",
  1: "AcceptWith",
  2: "Reject",
};

const SIDE_EFFECT_LABEL: Record<number, string> = {
  0: "none",
  1: "OverrideMaxLtvBps",
  2: "DelayLiquidationSlots",
  3: "OverrideRateBps",
  4: "OpenHedge",
};

export function receiptsCommand(): Command {
  return new Command("receipts")
    .description(
      "Pull a HookRan receipt off the chain and pretty-print it. Single signature for now; per-pool window coming next.",
    )
    .option("--signature <sig>", "Transaction signature to inspect")
    .option(
      "--rpc <url>",
      "RPC endpoint",
      "https://api.mainnet-beta.solana.com",
    )
    .action(async (opts: { signature?: string; rpc: string }) => {
      if (!opts.signature) {
        console.error(
          kleur.red("error:") +
            " --signature is required. example: agent-hooks receipts --signature 3AWddY...",
        );
        process.exitCode = 1;
        return;
      }
      const conn = new Connection(opts.rpc, "confirmed");
      const tx = await conn.getTransaction(opts.signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) {
        console.error(
          kleur.red("error:") +
            ` no transaction found at ${opts.signature} on ${opts.rpc}`,
        );
        process.exitCode = 1;
        return;
      }
      const logs = tx.meta?.logMessages ?? [];
      const parsed = parseExecutorLogs(logs);
      const receipt: ParsedReceipt = {
        signature: opts.signature,
        slot: tx.slot,
        blockTime: tx.blockTime ?? null,
        ...parsed,
      };
      console.log(kleur.bold().yellow("agent-hooks receipts"));
      console.log(`  signature       ${receipt.signature}`);
      console.log(`  slot            ${receipt.slot}`);
      console.log(
        `  block time      ${
          receipt.blockTime
            ? new Date(receipt.blockTime * 1000).toISOString()
            : "(unknown)"
        }`,
      );
      console.log(`  executor        ${AGENT_HOOKS_EXECUTOR_ID}`);
      if (receipt.event_kind !== undefined) {
        console.log(
          `  event           ${EVENT_KIND_LABEL[receipt.event_kind] ?? "?"} (kind=${receipt.event_kind})`,
        );
        console.log(`  pool            ${receipt.pool ?? "?"}`);
        console.log(`  composition     ${receipt.composition ?? "?"}`);
        if (receipt.hook_count_eligible !== undefined) {
          console.log(`  hooks eligible  ${receipt.hook_count_eligible}`);
          console.log(`  hooks skipped   ${receipt.hook_count_skipped}`);
        }
        if (receipt.hook_runs && receipt.hook_runs.length > 0) {
          console.log("");
          console.log(kleur.bold(`  HookRan entries (v0.1.3) — ${receipt.hook_runs.length} eligible:`));
          for (const [i, hr] of receipt.hook_runs.entries()) {
            console.log(`    [${i}] hook_program     ${hr.hook_program}`);
            console.log(`        priority          ${hr.priority}`);
            console.log(`        flags_bits        0x${hr.flags_bits.toString(16).padStart(4, "0")}`);
            console.log(
              `        decision          ${DECISION_LABEL[hr.decision] ?? "?"} (${hr.decision})`,
            );
            console.log(
              `        side_effect       ${SIDE_EFFECT_LABEL[hr.side_effect_kind] ?? "?"} payload=${hr.side_effect_payload}`,
            );
          }
        }
      } else {
        console.log(
          kleur.dim(
            "  (no CompositionExecuted / HookRan event in this transaction — was the signature an executor call?)",
          ),
        );
      }
      // Raw logs for forensics
      console.log("");
      console.log(kleur.dim("  raw program logs:"));
      for (const line of logs) {
        if (line.startsWith("Program log:") || line.includes("Program data:")) {
          console.log(kleur.dim(`    ${line}`));
        }
      }
    });
}
