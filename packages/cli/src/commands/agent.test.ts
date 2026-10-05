import assert from "node:assert/strict";
import test from "node:test";

import { agentCommand } from "./agent.js";

test("agent command retains its plan subcommand", () => {
  const command = agentCommand();
  assert.equal(command.name(), "agent");
  assert.ok(command.commands.some((child) => child.name() === "plan"));
});
