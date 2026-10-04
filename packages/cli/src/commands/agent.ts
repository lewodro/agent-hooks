import { createSimulationProposal, validateProposal } from "@agent-hooks/agent-runtime";
import { Command } from "commander";
import kleur from "kleur";

/** Creates a portable proposal artifact; it never signs or broadcasts. */
export function agentCommand(): Command {
  return new Command("agent")
    .description("Create a policy-checked, non-executing agent plan.")
    .command("plan")
    .description("Produce a simulation-only proposal for a hook objective.")
    .requiredOption("--objective <text>", "plain-language policy or risk objective")
    .option("--json", "emit JSON for an agent pipeline")
    .action((opts: { objective: string; json?: boolean }) => {
      const proposal = createSimulationProposal(opts.objective);
      const check = validateProposal(proposal);
      if (!check.valid) throw new Error(check.violations.join("; "));
      if (opts.json) {
        console.log(JSON.stringify(proposal, null, 2));
        return;
      }
      console.log(kleur.bold().cyan("Agent Hooks agent plan"));
      console.log(`  id        ${proposal.id}`);
      console.log(`  objective ${proposal.objective}`);
      console.log(`  action    ${proposal.actions[0]?.kind}`);
      console.log(kleur.gray("  safety    planning and simulation only; no wallet or RPC write access"));
    });
}
