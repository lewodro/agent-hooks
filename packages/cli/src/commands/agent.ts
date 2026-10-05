import {
  createSimulationProposal,
  proposalFingerprint,
  validateProposal,
} from "@agent-hooks/agent-runtime";
import { Command } from "commander";
import kleur from "kleur";

/** Creates a portable proposal artifact; it never signs or broadcasts. */
export function agentCommand(): Command {
  const command = new Command("agent").description("Create a policy-checked, non-executing agent plan.");
  command
    .command("plan")
    .description("Produce a simulation-only proposal for a hook objective.")
    .requiredOption("--objective <text>", "plain-language policy or risk objective")
    .option("--json", "emit JSON for an agent pipeline")
    .option("--fingerprint", "print the canonical proposal fingerprint for review systems")
    .action((opts: { objective: string; json?: boolean; fingerprint?: boolean }) => {
      const proposal = createSimulationProposal(opts.objective);
      const check = validateProposal(proposal);
      if (!check.valid) throw new Error(check.violations.join("; "));
      const fingerprint = proposalFingerprint(proposal);
      if (opts.fingerprint) {
        console.log(fingerprint);
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(proposal, null, 2));
        return;
      }
      console.log(kleur.bold().cyan("Agent Hooks agent plan"));
      console.log(`  id        ${proposal.id}`);
      console.log(`  fingerprint ${fingerprint}`);
      console.log(`  objective ${proposal.objective}`);
      console.log(`  action    ${proposal.actions[0]?.kind}`);
      console.log(kleur.gray("  safety    planning and simulation only; no wallet or RPC write access"));
    });
  return command;
}
