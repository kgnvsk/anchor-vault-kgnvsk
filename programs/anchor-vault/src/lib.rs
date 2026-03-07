use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("4UnyUVvoYXiV7c9nnWK6tYKJFQdSNG94qxSiHbv4qJKm");

/// # Anchor Vault
///
/// A simple, auditable SOL + SPL Token vault program built with the Anchor framework.
///
/// ## Features
/// - **Initialize** – create a personal vault PDA per owner.
/// - **Deposit** – anyone can deposit SOL into the vault.
/// - **Withdraw** – only the authorized owner can withdraw SOL.
/// - **Initialize Token Vault** – create a token vault for any SPL mint.
/// - **Deposit Token** – deposit any SPL token into the vault.
/// - **Withdraw Token** – withdraw SPL tokens (owner only).
/// - **View balance** – read lamports directly from the PDA account.
#[program]
pub mod anchor_vault {
    use super::*;

    /// Initialize the vault. Creates a vault PDA owned by the signer.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let vault_key = ctx.accounts.vault.key();
        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.bump = ctx.bumps.vault;
        vault.total_deposited = 0;

        emit!(VaultInitialized {
            owner: vault.owner,
            vault: vault_key,
            bump: vault.bump,
        });

        msg!("Vault initialized. Owner: {}", vault.owner);
        Ok(())
    }

    /// Deposit `amount` lamports from the depositor into the vault.
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

        emit!(SolDeposited {
            depositor: ctx.accounts.depositor.key(),
            vault: ctx.accounts.vault.key(),
            amount,
            total_deposited: ctx.accounts.vault.total_deposited,
        });

        msg!("Deposited {} lamports into vault", amount);
        Ok(())
    }

    /// Withdraw `amount` lamports from the vault to the owner.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);

        let vault_lamports = ctx.accounts.vault.to_account_info().lamports();
        let rent = Rent::get()?;
        let min_balance = rent.minimum_balance(8 + VaultState::LEN);
        let available = vault_lamports.saturating_sub(min_balance);

        require!(amount <= available, VaultError::InsufficientFunds);

        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.owner.try_borrow_mut_lamports()? += amount;

        emit!(SolWithdrawn {
            owner: ctx.accounts.owner.key(),
            vault: ctx.accounts.vault.key(),
            amount,
            remaining_lamports: ctx.accounts.vault.to_account_info().lamports(),
        });

        msg!("Withdrew {} lamports from vault", amount);
        Ok(())
    }

    /// Initialize a token vault for a specific SPL mint.
    pub fn initialize_token_vault(ctx: Context<InitializeTokenVault>) -> Result<()> {
        let token_vault_state_key = ctx.accounts.token_vault_state.key();
        let vault_token_account_key = ctx.accounts.vault_token_account.key();
        let token_vault = &mut ctx.accounts.token_vault_state;
        token_vault.owner = ctx.accounts.owner.key();
        token_vault.mint = ctx.accounts.mint.key();
        token_vault.bump = ctx.bumps.token_vault_state;
        token_vault.total_deposited = 0;

        emit!(TokenVaultInitialized {
            owner: token_vault.owner,
            mint: token_vault.mint,
            token_vault_state: token_vault_state_key,
            vault_token_account: vault_token_account_key,
            bump: token_vault.bump,
        });

        msg!("Token vault initialized. Owner: {}, Mint: {}", token_vault.owner, token_vault.mint);
        Ok(())
    }

    /// Deposit `amount` SPL tokens from depositor into the vault's token account.
    pub fn deposit_token(ctx: Context<DepositToken>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);

        let cpi_accounts = Transfer {
            from: ctx.accounts.depositor_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.depositor.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        ctx.accounts.token_vault_state.total_deposited = ctx
            .accounts
            .token_vault_state
            .total_deposited
            .saturating_add(amount);

        emit!(TokenDeposited {
            depositor: ctx.accounts.depositor.key(),
            mint: ctx.accounts.mint.key(),
            token_vault_state: ctx.accounts.token_vault_state.key(),
            vault_token_account: ctx.accounts.vault_token_account.key(),
            amount,
            total_deposited: ctx.accounts.token_vault_state.total_deposited,
        });

        msg!("Deposited {} tokens into token vault", amount);
        Ok(())
    }

    /// Withdraw `amount` SPL tokens from the vault to the owner's token account.
    pub fn withdraw_token(ctx: Context<WithdrawToken>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        require!(
            ctx.accounts.vault_token_account.amount >= amount,
            VaultError::InsufficientFunds
        );

        let owner_key = ctx.accounts.owner.key();
        let mint_key = ctx.accounts.token_vault_state.mint;
        let bump = ctx.accounts.token_vault_state.bump;
        let seeds: &[&[u8]] = &[
            b"token_vault",
            owner_key.as_ref(),
            mint_key.as_ref(),
            &[bump],
        ];
        let signer_seeds = &[seeds];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.owner_token_account.to_account_info(),
            authority: ctx.accounts.token_vault_state.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token::transfer(cpi_ctx, amount)?;

        emit!(TokenWithdrawn {
            owner: ctx.accounts.owner.key(),
            mint: ctx.accounts.mint.key(),
            token_vault_state: ctx.accounts.token_vault_state.key(),
            vault_token_account: ctx.accounts.vault_token_account.key(),
            amount,
            remaining_balance: ctx.accounts.vault_token_account.amount.saturating_sub(amount),
        });

        msg!("Withdrew {} tokens from token vault", amount);
        Ok(())
    }
}

// ─── Events ──────────────────────────────────────────────────────────────────

#[event]
pub struct VaultInitialized {
    pub owner: Pubkey,
    pub vault: Pubkey,
    pub bump: u8,
}

#[event]
pub struct SolDeposited {
    pub depositor: Pubkey,
    pub vault: Pubkey,
    pub amount: u64,
    pub total_deposited: u64,
}

#[event]
pub struct SolWithdrawn {
    pub owner: Pubkey,
    pub vault: Pubkey,
    pub amount: u64,
    pub remaining_lamports: u64,
}

#[event]
pub struct TokenVaultInitialized {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub token_vault_state: Pubkey,
    pub vault_token_account: Pubkey,
    pub bump: u8,
}

#[event]
pub struct TokenDeposited {
    pub depositor: Pubkey,
    pub mint: Pubkey,
    pub token_vault_state: Pubkey,
    pub vault_token_account: Pubkey,
    pub amount: u64,
    pub total_deposited: u64,
}

#[event]
pub struct TokenWithdrawn {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub token_vault_state: Pubkey,
    pub vault_token_account: Pubkey,
    pub amount: u64,
    pub remaining_balance: u64,
}

// ─── Account Contexts ────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

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
    #[account(mut)]
    pub depositor: Signer<'info>,

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

#[derive(Accounts)]
pub struct InitializeTokenVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = owner,
        space = 8 + TokenVaultState::LEN,
        seeds = [b"token_vault", owner.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub token_vault_state: Account<'info, TokenVaultState>,

    /// The vault's associated token account (PDA-owned)
    #[account(
        init,
        payer = owner,
        token::mint = mint,
        token::authority = token_vault_state,
        seeds = [b"token_vault_ata", owner.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositToken<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [b"token_vault", token_vault_state.owner.as_ref(), mint.key().as_ref()],
        bump = token_vault_state.bump,
        constraint = token_vault_state.mint == mint.key() @ VaultError::InvalidMint
    )]
    pub token_vault_state: Account<'info, TokenVaultState>,

    #[account(
        mut,
        seeds = [b"token_vault_ata", token_vault_state.owner.as_ref(), mint.key().as_ref()],
        bump
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = depositor_token_account.mint == mint.key() @ VaultError::InvalidMint
    )]
    pub depositor_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawToken<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [b"token_vault", owner.key().as_ref(), mint.key().as_ref()],
        bump = token_vault_state.bump,
        has_one = owner @ VaultError::Unauthorized,
        constraint = token_vault_state.mint == mint.key() @ VaultError::InvalidMint
    )]
    pub token_vault_state: Account<'info, TokenVaultState>,

    #[account(
        mut,
        seeds = [b"token_vault_ata", owner.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = owner_token_account.mint == mint.key() @ VaultError::InvalidMint,
        constraint = owner_token_account.owner == owner.key() @ VaultError::Unauthorized
    )]
    pub owner_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// ─── State ───────────────────────────────────────────────────────────────────

#[account]
pub struct VaultState {
    pub owner: Pubkey,
    pub bump: u8,
    pub total_deposited: u64,
}

impl VaultState {
    pub const LEN: usize = 32 + 1 + 8;
}

/// On-chain token vault metadata.
#[account]
pub struct TokenVaultState {
    /// The authorized owner who can withdraw tokens.
    pub owner: Pubkey,
    /// The SPL token mint this vault accepts.
    pub mint: Pubkey,
    /// PDA bump seed.
    pub bump: u8,
    /// Cumulative tokens deposited (informational).
    pub total_deposited: u64,
}

impl TokenVaultState {
    pub const LEN: usize = 32 + 32 + 1 + 8;
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
    #[msg("Token mint does not match vault mint")]
    InvalidMint,
}
