# Deployment

Agent Hooks is not deployed to devnet or mainnet. The checked-in executor address is the Solana system-program address solely as a visible placeholder; it must never be used as a deployment target.

## Before deployment

1. Generate a dedicated program keypair with the Solana CLI.
2. Replace the placeholder address consistently in `Anchor.toml`, the program's `declare_id!`, and the generated IDL.
3. Run the Rust and TypeScript test suites, then have the composition and program reviewed by an authorized operator.
4. Pass the real program ID to `ExecutorClient({ programId })` and to `agent-hooks receipts --program-id`.

## Operator-controlled release

`agent-hooks deploy --cluster <cluster>` prints a plan only. It has no signing or broadcast capability. After the checks above, an authorized operator may run the printed Anchor command with an explicit keypair and confirm the resulting program address independently.
