# Changelog

## 0.2.0 — Agent Hooks unreleased

- Established Agent Hooks as an independent repository and added packages, the command-line binary, Anchor program, and IDL.
- Removed inherited deployment, domain, and program-address claims; every deployment now requires an explicitly configured program ID.
- Added the policy-bound `@agent-hooks/agent-runtime` for auditable, simulation-only AI proposals.
- Added pnpm workspace, strict TypeScript base configuration, and Turbo task definitions.

## 0.1.0 — Initial imported architecture

- Rust lifecycle runtime and standard lending hook library.
- Anchor executor program with pool, composition, and hook-listing accounts.
- TypeScript adapters, SDK, CLI, and VS Code extension.
