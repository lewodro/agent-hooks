import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";

// Anchor test runner injects IDL + Program type during `anchor test`.
// Until then we type the Program loosely.
type AgentHooksExecutor = anchor.Program<anchor.Idl>;

describe("agent_hooks_executor", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // `workspace.AgentHooksExecutor` is populated by Anchor after `anchor build`.
  const program: AgentHooksExecutor = (anchor.workspace as Record<string, AgentHooksExecutor>)
    .AgentHooksExecutor;

  it("derives the program id from declare_id! in lib.rs", () => {
    expect(program.programId.toBase58()).to.equal(
      "5yNMqcyZsGQJk4xvw4jjvoRBSnGs8mgramEa3HQe5faD",
    );
  });

  it("rejects unknown adapter byte", async () => {
    const market = anchor.web3.Keypair.generate();
    const [poolPda, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), market.publicKey.toBuffer()],
      program.programId,
    );
    try {
      await program.methods
        .registerPool(99, bump)
        .accounts({
          pool: poolPda,
          market: market.publicKey,
          authority: provider.wallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      expect.fail("expected registerPool to throw on unknown adapter");
    } catch (err) {
      const msg = (err as Error).message ?? "";
      expect(msg).to.include("UnknownAdapter");
    }
  });

  it("registers a Marginfi pool", async () => {
    const market = anchor.web3.Keypair.generate();
    const [poolPda, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), market.publicKey.toBuffer()],
      program.programId,
    );
    await program.methods
      .registerPool(0, bump)
      .accounts({
        pool: poolPda,
        market: market.publicKey,
        authority: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const fetched = await (program.account as Record<string, anchor.AccountClient<anchor.Idl>>)
      .pool.fetch(poolPda);
    expect((fetched as { adapter: number }).adapter).to.equal(0);
  });
});
