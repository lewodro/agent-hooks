//! Agent Hooks Hook Executor — on-chain composition runner.
//!
//! Stores Composition PDAs (a list of registered hook program IDs + priorities + flags),
//! and exposes instructions that lending pool operators call from their
//! beforeBorrow / beforeLiquidate / afterDeposit hooks.

use anchor_lang::prelude::*;

// Replace with the keypair-derived program address before deployment.
declare_id!("11111111111111111111111111111111");

pub mod errors;
pub mod state;

use errors::HookExecutorError;
use state::{Composition, HookEntry, HookFlagsBitmap, Pool};

pub const MAX_HOOKS_PER_COMPOSITION: usize = 8;
pub const MAX_KEEPERS: usize = 16;

#[program]
pub mod agent_hooks_executor {
    use super::*;

    /// Register a lending pool with the executor. The pool authority controls
    /// which compositions may run against it.
    pub fn register_pool(
        ctx: Context<RegisterPool>,
        adapter: u8,
        bump: u8,
    ) -> Result<()> {
        require!(adapter <= 2, HookExecutorError::UnknownAdapter);
        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.adapter = adapter;
        pool.market = ctx.accounts.market.key();
        pool.composition_count = 0;
        pool.bump = bump;
        emit!(PoolRegistered {
            pool: pool.key(),
            adapter,
            market: pool.market,
            authority: pool.authority,
        });
        Ok(())
    }

    /// Install a Composition (ordered list of hooks) on a pool.
    pub fn install_composition(
        ctx: Context<InstallComposition>,
        slot_index: u8,
        entries: Vec<HookEntry>,
    ) -> Result<()> {
        require!(
            entries.len() <= MAX_HOOKS_PER_COMPOSITION,
            HookExecutorError::TooManyHooks
        );
        require!(!entries.is_empty(), HookExecutorError::EmptyComposition);
        // v0.1.1 — two compositions can't claim the same priority slot; the fold
        // walks priorities in order and ambiguous ties were silently coalescing.
        let mut seen = [false; (u8::MAX as usize) + 1];
        for entry in &entries {
            let p = entry.priority as usize;
            require!(!seen[p], HookExecutorError::DuplicatePriority);
            seen[p] = true;
        }
        let pool = &mut ctx.accounts.pool;
        require_keys_eq!(
            pool.authority,
            ctx.accounts.authority.key(),
            HookExecutorError::AuthorityMismatch
        );
        let composition = &mut ctx.accounts.composition;
        composition.pool = pool.key();
        composition.slot_index = slot_index;
        composition.entries = entries;
        composition.installed_at = Clock::get()?.unix_timestamp;
        composition.bump = ctx.bumps.composition;
        pool.composition_count = pool.composition_count.saturating_add(1);
        emit!(CompositionInstalled {
            pool: pool.key(),
            composition: composition.key(),
            slot_index,
            hook_count: composition.entries.len() as u8,
        });
        Ok(())
    }

    /// Replace the entries on an existing composition. Idempotent.
    pub fn update_composition(
        ctx: Context<UpdateComposition>,
        entries: Vec<HookEntry>,
    ) -> Result<()> {
        require!(
            entries.len() <= MAX_HOOKS_PER_COMPOSITION,
            HookExecutorError::TooManyHooks
        );
        require!(!entries.is_empty(), HookExecutorError::EmptyComposition);
        // v0.1.1 — same priority-uniqueness guard applied to updates.
        let mut seen = [false; (u8::MAX as usize) + 1];
        for entry in &entries {
            let p = entry.priority as usize;
            require!(!seen[p], HookExecutorError::DuplicatePriority);
            seen[p] = true;
        }
        let composition = &mut ctx.accounts.composition;
        require_keys_eq!(
            ctx.accounts.pool.authority,
            ctx.accounts.authority.key(),
            HookExecutorError::AuthorityMismatch
        );
        require_keys_eq!(
            composition.pool,
            ctx.accounts.pool.key(),
            HookExecutorError::CompositionPoolMismatch
        );
        composition.entries = entries;
        composition.installed_at = Clock::get()?.unix_timestamp;
        emit!(CompositionUpdated {
            composition: composition.key(),
            hook_count: composition.entries.len() as u8,
        });
        Ok(())
    }

    /// Execute the composition against a lifecycle event. The lending adapter
    /// CPIs this instruction inside its own before/after handler and inspects
    /// the result. The actual hook programs are invoked separately via
    /// `invoke_hook` so each hook can return its own logs and side-effects.
    pub fn run_composition(
        ctx: Context<RunComposition>,
        event_kind: u8,
        position_owner: Pubkey,
        adapter: u8,
        payload: Vec<u8>,
    ) -> Result<RunReceipt> {
        require!(event_kind <= 7, HookExecutorError::UnknownEventKind);
        let composition = &ctx.accounts.composition;
        let pool = &ctx.accounts.pool;
        require_keys_eq!(
            composition.pool,
            pool.key(),
            HookExecutorError::CompositionPoolMismatch
        );
        require!(adapter == pool.adapter, HookExecutorError::AdapterMismatch);
        require!(payload.len() <= 256, HookExecutorError::PayloadTooLarge);

        let event_bit = 1u16 << event_kind;
        let mut would_run = 0u8;
        let mut would_skip = 0u8;
        let now = Clock::get()?.unix_timestamp;
        for entry in &composition.entries {
            if entry.flags.bits & event_bit != 0 {
                would_run = would_run.saturating_add(1);
                // v0.1.3 — per-entry HookRan receipt for indexers / CLI / SDK.
                emit!(HookRan {
                    composition: composition.key(),
                    pool: pool.key(),
                    event_kind,
                    hook_program: entry.hook_program,
                    priority: entry.priority,
                    flags_bits: entry.flags.bits,
                    decision: 0,                // Accept (placeholder at executor layer)
                    side_effect_kind: 0,         // none (hook program emits the actual side-effect)
                    side_effect_payload: 0,
                    timestamp: now,
                });
            } else {
                would_skip = would_skip.saturating_add(1);
            }
        }

        emit!(CompositionExecuted {
            composition: composition.key(),
            pool: pool.key(),
            event_kind,
            position_owner,
            adapter,
            hook_count_eligible: would_run,
            hook_count_skipped: would_skip,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(RunReceipt {
            composition: composition.key(),
            event_kind,
            eligible_hooks: would_run,
            skipped_hooks: would_skip,
        })
    }

    /// Mark a hook as published in the marketplace. Listing data lives off-chain;
    /// this is the on-chain anchor for discovery + verification.
    pub fn publish_hook(
        ctx: Context<PublishHook>,
        flags: u16,
        manifest_uri: String,
        bump: u8,
    ) -> Result<()> {
        require!(flags != 0, HookExecutorError::EmptyFlags);
        require!(
            manifest_uri.len() <= 200,
            HookExecutorError::ManifestUriTooLong
        );
        let listing = &mut ctx.accounts.listing;
        listing.hook_program = ctx.accounts.hook_program.key();
        listing.author = ctx.accounts.author.key();
        listing.flags = HookFlagsBitmap { bits: flags };
        listing.manifest_uri = manifest_uri;
        listing.published_at = Clock::get()?.unix_timestamp;
        listing.bump = bump;
        emit!(HookPublished {
            hook_program: listing.hook_program,
            author: listing.author,
            flags,
        });
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(adapter: u8, bump: u8)]
pub struct RegisterPool<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Pool::SPACE,
        seeds = [b"pool", market.key().as_ref()],
        bump,
    )]
    pub pool: Account<'info, Pool>,
    /// CHECK: market account is whatever the adapter uses; checked off-chain.
    pub market: UncheckedAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(slot_index: u8, entries: Vec<HookEntry>)]
pub struct InstallComposition<'info> {
    #[account(mut)]
    pub pool: Account<'info, Pool>,
    #[account(
        init,
        payer = authority,
        space = 8 + Composition::SPACE,
        seeds = [b"composition", pool.key().as_ref(), &[slot_index]],
        bump,
    )]
    pub composition: Account<'info, Composition>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateComposition<'info> {
    #[account(mut)]
    pub composition: Account<'info, Composition>,
    pub pool: Account<'info, Pool>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct RunComposition<'info> {
    pub pool: Account<'info, Pool>,
    pub composition: Account<'info, Composition>,
    /// CHECK: caller (lending adapter program) is verified by the adapter itself.
    pub caller: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(flags: u16, manifest_uri: String, bump: u8)]
pub struct PublishHook<'info> {
    #[account(
        init,
        payer = author,
        space = 8 + state::HookListing::SPACE,
        seeds = [b"listing", hook_program.key().as_ref()],
        bump,
    )]
    pub listing: Account<'info, state::HookListing>,
    /// CHECK: pointer to the deployed hook program.
    pub hook_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub author: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct PoolRegistered {
    pub pool: Pubkey,
    pub adapter: u8,
    pub market: Pubkey,
    pub authority: Pubkey,
}

#[event]
pub struct CompositionInstalled {
    pub pool: Pubkey,
    pub composition: Pubkey,
    pub slot_index: u8,
    pub hook_count: u8,
}

#[event]
pub struct CompositionUpdated {
    pub composition: Pubkey,
    pub hook_count: u8,
}

#[event]
pub struct CompositionExecuted {
    pub composition: Pubkey,
    pub pool: Pubkey,
    pub event_kind: u8,
    pub position_owner: Pubkey,
    pub adapter: u8,
    pub hook_count_eligible: u8,
    pub hook_count_skipped: u8,
    pub timestamp: i64,
}


/// v0.1.3 — per-entry receipt. Emitted from inside run_composition for each
/// entry whose declared flags cover the lifecycle event. The decision and
/// side-effect fields are placeholders at this layer (the actual decision is
/// returned by the hook program itself when invoked); they're populated as
/// 0 = Accept / 0 = no side-effect by default so the receipt envelope is the
/// shape downstream tooling (CLI / SDK / explorer indexers) can rely on.
#[event]
pub struct HookRan {
    pub composition: Pubkey,
    pub pool: Pubkey,
    pub event_kind: u8,
    pub hook_program: Pubkey,
    pub priority: u16,
    pub flags_bits: u16,
    pub decision: u8,
    pub side_effect_kind: u8,
    pub side_effect_payload: u64,
    pub timestamp: i64,
}

#[event]
pub struct HookPublished {
    pub hook_program: Pubkey,
    pub author: Pubkey,
    pub flags: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RunReceipt {
    pub composition: Pubkey,
    pub event_kind: u8,
    pub eligible_hooks: u8,
    pub skipped_hooks: u8,
}
