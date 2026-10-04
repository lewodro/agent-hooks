#!/usr/bin/env node
import { Command } from "commander";

import { createCommand } from "./commands/create.js";
import { simulateCommand } from "./commands/simulate.js";
import { deployCommand } from "./commands/deploy.js";
import { listCommand } from "./commands/list.js";
import { actionCommand } from "./commands/action.js";
import { receiptsCommand } from "./commands/receipts.js";

const program = new Command();
program
  .name("agent-hooks")
  .description(
    "Agent Hooks — tie your loans. Create, simulate, and deploy Solana lending hooks.",
  )
  .version("0.1.2");

program.addCommand(createCommand());
program.addCommand(simulateCommand());
program.addCommand(deployCommand());
program.addCommand(listCommand());
program.addCommand(actionCommand());
program.addCommand(receiptsCommand());

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
