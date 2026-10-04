import { Command } from "commander";
import kleur from "kleur";

import { STANDARD_HOOK_NAMES } from "@agent-hooks/sdk";

const DESCRIPTIONS: Record<(typeof STANDARD_HOOK_NAMES)[number], string> = {
  DynamicLTV: "Tightens the max LTV as realised volatility climbs.",
  TimeTriggerLiq: "Limits liquidations to operator windows; delays under stale oracle.",
  WhitelistBorrow: "Restricts borrowing to a registered allowlist.",
  AntiMEVLiq: "Delays liquidation and (optionally) restricts to known keepers.",
  AutoHedge: "Opens a Drift perp short when collateral price drops below a band.",
  ReputationRate: "Discounts the borrow rate against on-chain repayment reputation.",
};

export function listCommand(): Command {
  return new Command("list").description("Print the standard hook library.").action(() => {
    console.log(kleur.bold().yellow("Agent Hooks standard hook library"));
    for (const name of STANDARD_HOOK_NAMES) {
      console.log(`  ${kleur.cyan(name.padEnd(18))} ${DESCRIPTIONS[name]}`);
    }
  });
}
