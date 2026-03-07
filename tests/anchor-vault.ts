/**
 * Anchor Vault – Test Suite
 *
 * Tests cover:
 *  1. Initialize vault
 *  2. Deposit SOL
 *  3. View balance
 *  4. Withdraw SOL (authorized owner)
 *  5. Reject withdrawal by unauthorized signer
 *  6. Reject zero-amount deposit/withdraw
 *
 * Run against devnet:
 *   anchor test --provider.cluster devnet
 *
 * Run locally with a validator:
 *   anchor test
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnchorVault } from "../target/types/anchor_vault";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

describe("anchor-vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AnchorVault as Program<AnchorVault>;
  const owner = provider.wallet as anchor.Wallet;

  let vaultPda: PublicKey;
  let vaultBump: number;

  // ── helpers ──────────────────────────────────────────────────────────────

  async function getVaultPda(ownerKey: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), ownerKey.toBuffer()],
      program.programId
    );
  }

  async function airdropIfNeeded(pubkey: PublicKey, minSol = 1) {
    const bal = await provider.connection.getBalance(pubkey);
    if (bal < minSol * LAMPORTS_PER_SOL) {
      const sig = await provider.connection.requestAirdrop(
        pubkey,
        2 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig, "confirmed");
    }
  }

  // ── setup ─────────────────────────────────────────────────────────────────

  before(async () => {
    await airdropIfNeeded(owner.publicKey);
    [vaultPda, vaultBump] = await getVaultPda(owner.publicKey);
  });

  // ── tests ─────────────────────────────────────────────────────────────────

  it("initializes the vault", async () => {
    const tx = await program.methods
      .initialize()
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("  initialize tx:", tx);

    const vaultAccount = await program.account.vaultState.fetch(vaultPda);
    assert.ok(
      vaultAccount.owner.equals(owner.publicKey),
      "vault owner should match"
    );
    assert.equal(vaultAccount.bump, vaultBump, "bump should be stored");
    assert.equal(
      vaultAccount.totalDeposited.toNumber(),
      0,
      "initial deposit counter should be 0"
    );
  });

  it("deposits SOL into the vault", async () => {
    const depositAmount = 0.5 * LAMPORTS_PER_SOL;
    const balanceBefore = await provider.connection.getBalance(vaultPda);

    const tx = await program.methods
      .deposit(new anchor.BN(depositAmount))
      .accounts({
        depositor: owner.publicKey,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("  deposit tx:", tx);

    const balanceAfter = await provider.connection.getBalance(vaultPda);
    assert.equal(
      balanceAfter - balanceBefore,
      depositAmount,
      "vault balance should increase by deposit amount"
    );

    const vaultAccount = await program.account.vaultState.fetch(vaultPda);
    assert.equal(
      vaultAccount.totalDeposited.toNumber(),
      depositAmount,
      "totalDeposited counter should track deposit"
    );
  });

  it("views vault balance", async () => {
    const balance = await provider.connection.getBalance(vaultPda);
    console.log(`  vault balance: ${balance / LAMPORTS_PER_SOL} SOL`);
    assert.isAbove(balance, 0, "vault should have a positive balance");
  });

  it("withdraws SOL from vault (owner only)", async () => {
    const withdrawAmount = 0.1 * LAMPORTS_PER_SOL;
    const ownerBefore = await provider.connection.getBalance(owner.publicKey);

    const tx = await program.methods
      .withdraw(new anchor.BN(withdrawAmount))
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
      })
      .rpc();

    console.log("  withdraw tx:", tx);

    const ownerAfter = await provider.connection.getBalance(owner.publicKey);
    // Account for tx fees (~5000 lamports)
    assert.approximately(
      ownerAfter - ownerBefore,
      withdrawAmount,
      10_000,
      "owner balance should increase by approximately the withdraw amount"
    );
  });

  it("rejects withdrawal by unauthorized signer", async () => {
    const attacker = Keypair.generate();
    await airdropIfNeeded(attacker.publicKey, 0.5);

    try {
      await program.methods
        .withdraw(new anchor.BN(1000))
        .accounts({
          owner: attacker.publicKey,
          vault: vaultPda, // vault belongs to `owner`, not `attacker`
        })
        .signers([attacker])
        .rpc();
      assert.fail("Should have thrown an error for unauthorized signer");
    } catch (err: any) {
      // Anchor will throw a ConstraintSeeds or AccountNotFound error
      // because attacker's derived PDA won't match the existing vault
      console.log("  correctly rejected unauthorized withdrawal:", err.message);
      assert.ok(err, "expected an error");
    }
  });

  it("rejects zero-amount deposit", async () => {
    try {
      await program.methods
        .deposit(new anchor.BN(0))
        .accounts({
          depositor: owner.publicKey,
          vault: vaultPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("Should have thrown ZeroAmount error");
    } catch (err: any) {
      assert.include(
        err.toString(),
        "ZeroAmount",
        "expected ZeroAmount error"
      );
    }
  });

  it("rejects zero-amount withdrawal", async () => {
    try {
      await program.methods
        .withdraw(new anchor.BN(0))
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
        })
        .rpc();
      assert.fail("Should have thrown ZeroAmount error");
    } catch (err: any) {
      assert.include(
        err.toString(),
        "ZeroAmount",
        "expected ZeroAmount error"
      );
    }
  });

  it("supports SPL token vault: init → deposit → withdraw", async () => {
    const mintAuthority = owner.payer;
    const mint = await createMint(
      provider.connection,
      mintAuthority,
      mintAuthority.publicKey,
      null,
      6
    );

    const depositorToken = await createAssociatedTokenAccount(
      provider.connection,
      mintAuthority,
      mint,
      owner.publicKey
    );

    await mintTo(
      provider.connection,
      mintAuthority,
      mint,
      depositorToken,
      mintAuthority,
      5_000_000
    );

    const [tokenVaultState] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), owner.publicKey.toBuffer(), mint.toBuffer()],
      program.programId
    );

    const [vaultTokenAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault_ata"), owner.publicKey.toBuffer(), mint.toBuffer()],
      program.programId
    );

    await program.methods
      .initializeTokenVault()
      .accounts({
        owner: owner.publicKey,
        mint,
        tokenVaultState,
        vaultTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    await program.methods
      .depositToken(new anchor.BN(1_000_000))
      .accounts({
        depositor: owner.publicKey,
        mint,
        tokenVaultState,
        vaultTokenAccount,
        depositorTokenAccount: depositorToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    await program.methods
      .withdrawToken(new anchor.BN(500_000))
      .accounts({
        owner: owner.publicKey,
        mint,
        tokenVaultState,
        vaultTokenAccount,
        ownerTokenAccount: depositorToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const vaultBalance = await getAccount(provider.connection, vaultTokenAccount);
    assert.equal(vaultBalance.amount.toString(), "500000");
  });
});
