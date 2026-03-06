use anchor_lang::prelude::*;

declare_id!("Vault111111111111111111111111111111111111111");

/// # Anchor Vault
///
/// A simple, auditable SOL vault program built with the Anchor framework.
///
/// ## Features
/// - **Initialize** – create a personal vault PDA per owner.
/// - **Deposit** – anyone can deposit SOL into the vault.
/// - **Withdraw** – only the authorized owner can withdraw SOL.
/// - **View balance** – read lamports directly from the PDA account.
#[program]
pub mod anchor_vault {
    use super::*;

    /// Initialize the vault. Creates a vault PDA owned by the signer.
    ///
    /// The vault address is deterministically derived from
    /// `["vault", owner_pubkey]` so each wallet gets exactly one vault.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.bump = ctx.bumps.vault;
        vault.total_deposited = 0;
        msg!("Vault initialized. Owner: {}", vault.owner);
        Ok(())
    }

    /// Deposit `amount` lamports from the depositor into the vault.
    ///
    /// Anyone can deposit (useful for funding vaults on behalf of others).
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);

        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.depositor.key(),
            &ctx.accounts.vault.key(),
            amount,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.depositor.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        ctx.accounts.vault.total_deposited = ctx
            .accounts
            .vault
            .total_deposited
            .saturating_add(amount);

        msg!("Deposited {} lamports into vault", amount);
        Ok(())
    }

    /// Withdraw `amount` lamports from the vault to the owner.
    ///
    /// Only the owner stored in the vault state may call this instruction.
    /// The vault must retain enough lamports to remain rent-exempt.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);

        let vault_lamports = ctx.accounts.vault.to_account_info().lamports();
        let rent = Rent::get()?;
        let min_balance = rent.minimum_balance(8 + VaultState::LEN);
        let available = vault_lamports.saturating_sub(min_balance);

        require!(amount <= available, VaultError::InsufficientFunds);

        // Direct lamport transfer from PDA – safe because vault is owned by this program
        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.owner.try_borrow_mut_lamports()? += amount;

        msg!("Withdrew {} lamports from vault", amount);
        Ok(())
    }
}

// ─── Account Contexts ────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    /// The wallet that will own (and fund) the vault.
    #[account(mut)]
    pub owner: Signer<'info>,

    /// Vault PDA: seeds = ["vault", owner].
    #[account(
        init,
        payer = owner,
        space = 8 + VaultState::LEN,
        seeds = [b"vault", owner.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, VaultState>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    /// Anyone can be the depositor.
    #[account(mut)]
    pub depositor: Signer<'info>,

    /// The vault to fund.
    #[account(
        mut,
        seeds = [b"vault", vault.owner.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, VaultState>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    /// Must match `vault.owner`.
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ VaultError::Unauthorized
    )]
    pub vault: Account<'info, VaultState>,
}

// ─── State ───────────────────────────────────────────────────────────────────

/// On-chain vault metadata stored in the PDA account.
#[account]
pub struct VaultState {
    /// The authorized owner who can withdraw funds.
    pub owner: Pubkey,
    /// PDA bump seed cached to save compute.
    pub bump: u8,
    /// Cumulative lamports deposited (informational).
    pub total_deposited: u64,
}

impl VaultState {
    /// Byte size of the account data (excluding the 8-byte discriminator).
    pub const LEN: usize = 32  // owner: Pubkey
        + 1   // bump: u8
        + 8;  // total_deposited: u64
}

// ─── Custom Errors ───────────────────────────────────────────────────────────

#[error_code]
pub enum VaultError {
    #[msg("Only the vault owner can withdraw")]
    Unauthorized,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Insufficient funds available in vault")]
    InsufficientFunds,
}
