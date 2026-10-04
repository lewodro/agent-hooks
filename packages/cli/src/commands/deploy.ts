import { Command } from "commander";
import kleur from "kleur";

export function deployCommand(): Command {
  return new Command("deploy")
    .description(
      "Print the exact Anchor command sequence used to deploy agent-hooks-executor. " +
        "This command never signs on its own — you run `anchor deploy` yourself with your keypair.",
    )
    .option("--cluster <cluster>", "localnet | devnet | mainnet", "localnet")
    .option("--keypair <path>", "path to deployer keypair", "~/.config/solana/id.json")
    .action((opts: { cluster: string; keypair: string }) => {
      console.log(kleur.bold().yellow("Agent Hooks deploy plan"));
      console.log(kleur.gray("  (Run these yourself — `agent-hooks deploy` never broadcasts.)"));
      console.log("");
      console.log(`  1) anchor build`);
      console.log(`  2) solana balance --keypair ${opts.keypair}`);
      console.log(`  3) anchor deploy --provider.cluster ${opts.cluster} --provider.wallet ${opts.keypair}`);
      console.log(`  4) solana program show <PROGRAM_ID> --url ${opts.cluster}`);
      console.log("");
      if (opts.cluster === "mainnet") {
        console.log(kleur.red().bold("Mainnet deploy requires explicit operator approval. Confirm the keypair pubkey above before proceeding."));
      }
    });
}
