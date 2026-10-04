import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";
import kleur from "kleur";

const WORKFLOW = `name: agent-hooks-hook-ci
on: [push, pull_request]
jobs:
  simulate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm install -g @agent-hooks/cli
      - run: agent-hooks list
      - run: agent-hooks simulate --steps 120 --pool $\\{{ vars.AGENT_HOOKS_POOL || 'SOL-USDC' \\}}
`;

export function actionCommand(): Command {
  return new Command("action")
    .description("Generate a GitHub Actions workflow that runs `agent-hooks simulate` on every push.")
    .action(async () => {
      const dir = path.resolve(process.cwd(), ".github", "workflows");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "agent-hooks-hook-ci.yml"), WORKFLOW.replace(/\\/g, ""));
      console.log(kleur.green(`Wrote ${path.join(dir, "agent-hooks-hook-ci.yml")}`));
    });
}
