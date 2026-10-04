import * as vscode from "vscode";

import { renderKnotDiagram } from "./diagram.js";
import { runSimulation } from "./simulate.js";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("agent-hooks.openDesigner", openDesigner),
    vscode.commands.registerCommand("agent-hooks.simulate", () => simulate(context)),
    vscode.commands.registerCommand("agent-hooks.deployPlan", showDeployPlan),
  );
}

export function deactivate(): void {
  /* no-op */
}

function openDesigner(): void {
  const panel = vscode.window.createWebviewPanel(
    "agent-hooks.designer",
    "Agent Hooks Hook Designer",
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = renderKnotDiagram();
}

async function simulate(context: vscode.ExtensionContext): Promise<void> {
  const pool = vscode.workspace.getConfiguration("agent-hooks").get<string>("defaultPool") ?? "SOL-USDC";
  const report = runSimulation({ pool, steps: 60 });
  const channel = vscode.window.createOutputChannel("Agent Hooks");
  context.subscriptions.push(channel);
  channel.show(true);
  channel.appendLine(`Agent Hooks simulation — pool=${pool}, events=${report.totalEvents}`);
  channel.appendLine(`  ltv overrides       ${report.ltvOverrides}`);
  channel.appendLine(`  rate overrides      ${report.rateOverrides}`);
  channel.appendLine(`  liquidations delay  ${report.liquidationsDelayed}`);
  channel.appendLine(`  liquidations exec   ${report.liquidationsExecuted}`);
  channel.appendLine(`  borrows rejected    ${report.borrowsRejected}`);
}

function showDeployPlan(): void {
  const cluster = vscode.workspace.getConfiguration("agent-hooks").get<string>("cluster") ?? "localnet";
  const lines = [
    `Agent Hooks deploy plan — cluster: ${cluster}`,
    "",
    "1) anchor build",
    "2) solana balance --keypair <YOUR_KEYPAIR>",
    `3) anchor deploy --provider.cluster ${cluster} --provider.wallet <YOUR_KEYPAIR>`,
    "4) solana program show <PROGRAM_ID>",
    "",
    cluster === "mainnet"
      ? "Mainnet deploy requires explicit operator approval. Confirm the keypair pubkey before broadcasting."
      : "",
  ];
  vscode.window.showInformationMessage(lines.filter(Boolean).join("\n"), { modal: false });
}
