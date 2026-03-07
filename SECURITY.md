# SECURITY

## Scope
This document covers the on-chain security model for `anchor-vault`:
- SOL vault (`initialize`, `deposit`, `withdraw`)
- SPL token vault (`initialize_token_vault`, `deposit_token`, `withdraw_token`)

## Threat Model

### Assets
- SOL lamports held by `VaultState` PDA accounts.
- SPL tokens held by vault token accounts (`token_vault_ata` PDA).
- Vault authority invariants (owner-only withdrawal semantics).

### Trust assumptions
- Solana runtime correctly enforces PDA derivation, ownership, and signer checks.
- SPL Token Program correctly enforces token transfer/mint semantics.
- Clients provide correct account metas; malicious clients are expected and supported.

### Adversary capabilities
Adversary may:
- Submit arbitrary transactions and reorder their own transaction attempts.
- Provide malformed account sets, mismatched mint accounts, or zero-amount calls.
- Attempt unauthorized withdrawals by spoofing owner identities.

Adversary may not:
- Forge PDA signatures.
- Break Solana runtime or Token Program cryptographic assumptions.

## Security Controls

### 1) Deterministic PDA authorities
- SOL vault PDA: seeds `["vault", owner_pubkey]`
- Token vault PDA state: `["token_vault", owner_pubkey, mint_pubkey]`
- Token vault ATA PDA: `["token_vault_ata", owner_pubkey, mint_pubkey]`

These constraints prevent arbitrary account substitution.

### 2) Owner-only withdrawals
- SOL: `Withdraw` context uses owner signer and PDA seed checks.
- SPL: `WithdrawToken` binds owner signer + vault PDA seeds + owner token account ownership.

### 3) Mint integrity checks
- `DepositToken` and `WithdrawToken` enforce mint consistency and reject mismatches (`InvalidMint`).

### 4) Zero-amount prevention
- All movement instructions reject `amount == 0` with `ZeroAmount`.

### 5) SOL rent-safety
- SOL withdrawals are bounded by vault balance minus rent-exempt minimum to prevent account deallocation via withdrawal.

### 6) CPI signer minimization
- SPL withdrawals sign only with PDA seeds for token vault authority.

## Residual Risks
- No timelock or multi-sig controls; a compromised owner key can drain owned vaults.
- `total_deposited` is informational and not a source of truth for spendable balance.
- No pause/guardian emergency mechanism.
- No dispute resolution / escrow policy layer; this is a primitive vault.

## Non-goals
- No confidentiality (all account state and transfers are public on-chain).
- No protection against compromised client endpoints or stolen owner private keys.
- No off-chain fraud prevention, KYC, compliance, or legal arbitration.
- No protocol-level insurance.

## Recommended Operational Practices
- Use hardware wallets for owner key material.
- Audit account inputs in clients before transaction submission.
- Monitor events and on-chain balances for anomaly detection.
- Add external governance (multisig/timelock) if used in production custody flows.
