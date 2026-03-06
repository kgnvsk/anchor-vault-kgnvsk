# 🔐 Anchor Vault

> **Superteam Earn Bounty** – Beginner Challenge | $450 USDG

A clean, well-documented SOL vault program built with the [Anchor](https://www.anchor-lang.com/) framework on Solana.

---

## Features

| Instruction | Description |
|-------------|-------------|
| `initialize` | Creates a vault PDA for the caller. One vault per wallet. |
| `deposit` | Deposits SOL into the vault. Anyone can fund a vault. |
| `withdraw` | Withdraws SOL from the vault. **Owner only.** |
| Balance query | Read vault lamports directly from the PDA account. |

---

## Architecture

```
Owner Wallet
    │
    ├── initialize()  →  Vault PDA  [seeds: "vault" + owner_pubkey]
    │                       │
    ├── deposit()  ─────────┤  (anyone can deposit)
    │                       │
    └── withdraw()  ◄────── ┘  (owner only)
```

The vault is a **Program Derived Address (PDA)** with seeds `["vault", owner_pubkey]`, meaning:
- Each owner gets exactly **one vault** with a deterministic address.
- The program is the **sole authority** over the PDA — no private key exists.
- Withdrawals require the signer to match the stored `owner` field.

---

## Prerequisites

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install Solana CLI
sh -c "$(curl -sSfL https://release.solana.com/stable/install)"

# Install Anchor CLI
cargo install --git https://github.com/coral-xyz/anchor anchor-cli

# Install Node dependencies
yarn install
```

---

## Build & Test

```bash
# Build the program
anchor build

# Run tests on devnet
anchor test --provider.cluster devnet

# Run tests locally (spins up local validator)
anchor test
```

---

## Deploy to Devnet

```bash
# Configure Solana CLI for devnet
solana config set --url devnet

# Airdrop SOL for fees
solana airdrop 2

# Deploy
anchor deploy --provider.cluster devnet
```

---

## Program State

```rust
pub struct VaultState {
    pub owner: Pubkey,          // 32 bytes – authorized withdrawer
    pub bump: u8,               //  1 byte  – PDA bump seed (cached)
    pub total_deposited: u64,   //  8 bytes – cumulative deposit counter
}
// Total account size: 8 (discriminator) + 41 bytes = 49 bytes
```

---

## Security Notes

- The `has_one = owner` constraint on `Withdraw` ensures only the vault owner can withdraw — enforced by Anchor at the account-deserialization level.
- The program retains rent-exempt minimum lamports in the vault; you cannot drain it below that threshold.
- PDA ownership is enforced by the Solana runtime — no spoofing possible.

---

## Project Structure

```
anchor-vault-kgnvsk/
├── Anchor.toml
├── Cargo.toml
├── package.json
├── tsconfig.json
├── programs/
│   └── anchor-vault/
│       ├── Cargo.toml
│       └── src/
│           └── lib.rs          ← Program logic
└── tests/
    └── anchor-vault.ts         ← TypeScript test suite (6 tests)
```

---

## License

MIT
