//! Example CPI guard for a Solana agent executor.
//!
//! The configured executor must invoke `authorize_execution` before its state
//! mutation and use the same quote/min-out values in its downstream operation.
//! This program cannot force unrelated programs to consult this policy.

use anchor_lang::prelude::*;

declare_id!("6fWZrDV2FxUUmgqWoYGmH9rCcgGPW2MnrNYTNsZUtWZv");

pub const MAX_SLIPPAGE_BPS: u16 = 10_000;

#[program]
pub mod agent_hooks_policy {
    use super::*;

    pub fn initialize_policy(
        ctx: Context<InitializePolicy>,
        max_slippage_bps: u16,
        cooldown_slots: u64,
    ) -> Result<()> {
        require!(
            max_slippage_bps <= MAX_SLIPPAGE_BPS,
            PolicyError::InvalidSlippageLimit
        );

        let (expected_authority, _) = Pubkey::find_program_address(
            &[b"agent-authority", ctx.accounts.owner.key().as_ref()],
            &ctx.accounts.executor_program.key(),
        );
        require_keys_eq!(
            expected_authority,
            ctx.accounts.executor_authority.key(),
            PolicyError::InvalidExecutorAuthority
        );

        let policy = &mut ctx.accounts.policy;
        policy.owner = ctx.accounts.owner.key();
        policy.executor_program = ctx.accounts.executor_program.key();
        policy.executor_authority = expected_authority;
        policy.max_slippage_bps = max_slippage_bps;
        policy.cooldown_slots = cooldown_slots;
        policy.last_execution_slot = 0;
        policy.has_executed = false;
        policy.paused = false;
        policy.bump = ctx.bumps.policy;

        emit!(PolicyInitialized {
            policy: policy.key(),
            owner: policy.owner,
            executor_program: policy.executor_program,
            max_slippage_bps,
            cooldown_slots,
        });
        Ok(())
    }

    pub fn update_limits(
        ctx: Context<UpdatePolicy>,
        max_slippage_bps: u16,
        cooldown_slots: u64,
    ) -> Result<()> {
        require!(
            max_slippage_bps <= MAX_SLIPPAGE_BPS,
            PolicyError::InvalidSlippageLimit
        );
        let policy = &mut ctx.accounts.policy;
        policy.max_slippage_bps = max_slippage_bps;
        policy.cooldown_slots = cooldown_slots;
        emit!(PolicyLimitsUpdated {
            policy: policy.key(),
            max_slippage_bps,
            cooldown_slots,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<UpdatePolicy>, paused: bool) -> Result<()> {
        ctx.accounts.policy.paused = paused;
        emit!(PolicyPauseChanged {
            policy: ctx.accounts.policy.key(),
            paused,
        });
        Ok(())
    }

    /// Must be called via CPI by the configured executor. `quoted_out` and
    /// `minimum_out` must be exactly the values used by its state-mutating CPI.
    pub fn authorize_execution(
        ctx: Context<AuthorizeExecution>,
        quoted_out: u64,
        minimum_out: u64,
        action_hash: [u8; 32],
    ) -> Result<()> {
        let policy = &mut ctx.accounts.policy;
        require!(!policy.paused, PolicyError::PolicyPaused);
        require_keys_eq!(
            ctx.accounts.executor_program.key(),
            policy.executor_program,
            PolicyError::InvalidExecutorProgram
        );
        require_keys_eq!(
            ctx.accounts.executor_authority.key(),
            policy.executor_authority,
            PolicyError::InvalidExecutorAuthority
        );

        let slippage_bps = calculate_slippage_bps(quoted_out, minimum_out)
            .ok_or(error!(PolicyError::InvalidQuote))?;
        require!(
            slippage_bps <= policy.max_slippage_bps,
            PolicyError::SlippageLimitExceeded
        );

        let slot = Clock::get()?.slot;
        if policy.has_executed {
            let next_allowed = policy
                .last_execution_slot
                .checked_add(policy.cooldown_slots)
                .ok_or(error!(PolicyError::CooldownOverflow))?;
            require!(slot >= next_allowed, PolicyError::CooldownNotElapsed);
        }

        policy.last_execution_slot = slot;
        policy.has_executed = true;
        emit!(ExecutionAuthorized {
            policy: policy.key(),
            executor_program: policy.executor_program,
            action_hash,
            slot,
            slippage_bps,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializePolicy<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + GuardPolicy::SPACE,
        seeds = [b"guard-policy", owner.key().as_ref()],
        bump,
    )]
    pub policy: Account<'info, GuardPolicy>,
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: Must be executable; its ID and authority PDA are pinned in policy.
    #[account(executable)]
    pub executor_program: UncheckedAccount<'info>,
    /// CHECK: Checked against a PDA derived under executor_program in the handler.
    pub executor_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
    #[account(
        mut,
        seeds = [b"guard-policy", owner.key().as_ref()],
        bump = policy.bump,
        has_one = owner @ PolicyError::UnauthorizedOwner,
    )]
    pub policy: Account<'info, GuardPolicy>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct AuthorizeExecution<'info> {
    #[account(
        mut,
        seeds = [b"guard-policy", policy.owner.as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, GuardPolicy>,
    #[account(address = policy.executor_authority)]
    pub executor_authority: Signer<'info>,
    /// CHECK: Pinned to the executable program ID stored by the policy owner.
    #[account(address = policy.executor_program, executable)]
    pub executor_program: UncheckedAccount<'info>,
}

#[account]
pub struct GuardPolicy {
    pub owner: Pubkey,
    pub executor_program: Pubkey,
    pub executor_authority: Pubkey,
    pub max_slippage_bps: u16,
    pub cooldown_slots: u64,
    pub last_execution_slot: u64,
    pub has_executed: bool,
    pub paused: bool,
    pub bump: u8,
}

impl GuardPolicy {
    pub const SPACE: usize = 32 + 32 + 32 + 2 + 8 + 8 + 1 + 1 + 1;
}

#[event]
pub struct PolicyInitialized {
    pub policy: Pubkey,
    pub owner: Pubkey,
    pub executor_program: Pubkey,
    pub max_slippage_bps: u16,
    pub cooldown_slots: u64,
}

#[event]
pub struct PolicyLimitsUpdated {
    pub policy: Pubkey,
    pub max_slippage_bps: u16,
    pub cooldown_slots: u64,
}

#[event]
pub struct PolicyPauseChanged {
    pub policy: Pubkey,
    pub paused: bool,
}

#[event]
pub struct ExecutionAuthorized {
    pub policy: Pubkey,
    pub executor_program: Pubkey,
    pub action_hash: [u8; 32],
    pub slot: u64,
    pub slippage_bps: u16,
}

#[error_code]
pub enum PolicyError {
    #[msg("Maximum slippage must be at most 10,000 basis points")]
    InvalidSlippageLimit,
    #[msg("The configured executor authority is not its expected PDA")]
    InvalidExecutorAuthority,
    #[msg("The executor program does not match the policy")]
    InvalidExecutorProgram,
    #[msg("Quote must be nonzero and minimum output cannot exceed quoted output")]
    InvalidQuote,
    #[msg("Execution slippage exceeds the configured maximum")]
    SlippageLimitExceeded,
    #[msg("The execution cooldown has not elapsed")]
    CooldownNotElapsed,
    #[msg("Cooldown slot calculation overflowed")]
    CooldownOverflow,
    #[msg("Policy is paused")]
    PolicyPaused,
    #[msg("Only the policy owner may update limits")]
    UnauthorizedOwner,
}

fn calculate_slippage_bps(quoted_out: u64, minimum_out: u64) -> Option<u16> {
    if quoted_out == 0 || minimum_out > quoted_out {
        return None;
    }
    let loss = u128::from(quoted_out - minimum_out);
    let denominator = u128::from(quoted_out);
    let numerator = loss.checked_mul(u128::from(MAX_SLIPPAGE_BPS))?;
    // Round up so a fractional basis point cannot slip under the configured cap.
    let bps = numerator.checked_add(denominator - 1)? / denominator;
    u16::try_from(bps).ok()
}

#[cfg(test)]
mod tests {
    use super::calculate_slippage_bps;

    #[test]
    fn computes_slippage_in_basis_points() {
        assert_eq!(calculate_slippage_bps(10_000, 9_900), Some(100));
        assert_eq!(calculate_slippage_bps(10_000, 10_000), Some(0));
        assert_eq!(calculate_slippage_bps(3, 2), Some(3_334));
    }

    #[test]
    fn rejects_invalid_quote_bounds() {
        assert_eq!(calculate_slippage_bps(0, 0), None);
        assert_eq!(calculate_slippage_bps(10, 11), None);
    }

    #[test]
    fn bounds_full_slippage() {
        assert_eq!(calculate_slippage_bps(u64::MAX, 0), Some(10_000));
    }
}
