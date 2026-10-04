import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";
import kleur from "kleur";
import prompts from "prompts";

import { STANDARD_HOOK_NAMES } from "@agent-hooks/sdk";

const TEMPLATE = (name: string, lifecycle: string) => `import { Hook, HookContext, HookDecision, flagsFrom } from "@agent-hooks/sdk";

export class ${name} implements Hook {
  readonly meta = {
    name: "${name}",
    version: "0.1.0",
    author: "<your handle>",
    flags: flagsFrom(["${lifecycle}"]),
    description: "TODO: describe what this hook does",
  };

  evaluate(ctx: HookContext): HookDecision {
    void ctx;
    return HookDecision.Accept;
  }
}
`;

export function createCommand(): Command {
  return new Command("create")
    .description("Scaffold a new hook in a folder.")
    .argument("[kind]", "hook | composition")
    .option("-n, --name <name>", "hook name (PascalCase)")
    .option("-l, --lifecycle <lifecycle>", "lifecycle flag", "BeforeBorrow")
    .action(async (kind: string | undefined, opts: { name?: string; lifecycle: string }) => {
      const target = kind ?? (await prompts({
        type: "select",
        name: "v",
        message: "What do you want to create?",
        choices: [
          { title: "hook (single hook program)", value: "hook" },
          { title: "composition (TS file that bundles existing hooks)", value: "composition" },
        ],
      })).v;

      if (target === "hook") {
        const name = opts.name ?? (await prompts({
          type: "text",
          name: "v",
          message: "Hook name (PascalCase)",
        })).v;
        const lifecycle = opts.lifecycle;
        if (!name) throw new Error("Hook name required");
        const dir = path.resolve(process.cwd(), name);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, `${name}.ts`), TEMPLATE(name, lifecycle));
        console.log(kleur.green(`Created ${path.join(dir, `${name}.ts`)}`));
        console.log(`Next: ${kleur.yellow(`agent-hooks simulate --hook ${name}`)}`);
        return;
      }

      if (target === "composition") {
        const hooks = await prompts({
          type: "multiselect",
          name: "v",
          message: "Pick hooks to include",
          choices: STANDARD_HOOK_NAMES.map((n) => ({ title: n, value: n, selected: false })),
        });
        const out = `import {
  Composition,
  ${(hooks.v as string[]).map((h) => h[0]?.toLowerCase() + h.slice(1)).join(",\n  ")}
} from "@agent-hooks/sdk";

export const composition = new Composition()
  ${(hooks.v as string[]).map((h, i) => `.add(${h[0]?.toLowerCase() + h.slice(1)}({ programId: "<replace>", priority: ${i * 10}, ${defaultArgs(h)} }))`).join("\n  ")};
`;
        await writeFile(path.resolve(process.cwd(), "composition.ts"), out);
        console.log(kleur.green("Created composition.ts"));
        return;
      }

      throw new Error(`Unknown create target: ${target}`);
    });
}

function defaultArgs(name: string): string {
  switch (name) {
    case "DynamicLTV":
      return "baseLtvBps: 7500, sensitivity: 50, volFloorBps: 1000, minLtvBps: 2500";
    case "TimeTriggerLiq":
      return "allowedWindows: [{ startSec: 36000, endSec: 64800 }], maxOracleAgeSlots: 500, delaySlots: 300";
    case "WhitelistBorrow":
      return "allowedOwners: []";
    case "AntiMEVLiq":
      return "minDelaySlots: 3, keepers: []";
    case "AutoHedge":
      return "triggerPriceE8: 8000000000n, hedgeRatioBps: 5000, marketPubkey: \"<drift-market>\"";
    case "ReputationRate":
      return "baseRateBps: 1200, maxDiscountBps: 600, providerProgram: \"<provider>\"";
    default:
      return "";
  }
}
