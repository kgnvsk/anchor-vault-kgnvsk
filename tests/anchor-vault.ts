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
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

describe("anchor-vault hardening", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AnchorVault as Program<AnchorVault>;
  const owner = provider.wallet as anchor.Wallet;

  let vaultPda: PublicKey;
  let vaultBump: number;

  let mintA: PublicKey;
  let mintB: PublicKey;
  let ownerTokenA: PublicKey;
  let ownerTokenB: PublicKey;
  let tokenVaultStateA: PublicKey;
  let vaultTokenAccountA: PublicKey;

  const signer = owner.payer;

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

  function findVault(ownerKey: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), ownerKey.toBuffer()],
      program.programId
    );
  }

  function findTokenVault(ownerKey: PublicKey, mint: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), ownerKey.toBuffer(), mint.toBuffer()],
      program.programId
    )[0];
  }

  function findTokenVaultAta(ownerKey: PublicKey, mint: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault_ata"), ownerKey.toBuffer(), mint.toBuffer()],
      program.programId
    )[0];
  }

  async function expectFails(promise: Promise<unknown>, needles: string[]) {
    try {
      await promise;
      assert.fail("expected transaction to fail");
    } catch (err: any) {
      const text = (err?.toString?.() ?? String(err)).toLowerCase();
      const ok = needles.some((n) => text.includes(n.toLowerCase()));
      assert.isTrue(
        ok,
        `unexpected error: ${text} (expected one of: ${needles.join(", ")})`
      );
    }
  }

  before(async () => {
    await airdropIfNeeded(owner.publicKey, 2);
    [vaultPda, vaultBump] = findVault(owner.publicKey);

    mintA = await createMint(
      provider.connection,
      signer,
      owner.publicKey,
      null,
      6
    );
    mintB = await createMint(
      provider.connection,
      signer,
      owner.publicKey,
      null,
      6
    );

    ownerTokenA = await createAssociatedTokenAccount(
      provider.connection,
      signer,
      mintA,
      owner.publicKey
    );
    ownerTokenB = await createAssociatedTokenAccount(
      provider.connection,
      signer,
      mintB,
      owner.publicKey
    );

    await mintTo(provider.connection, signer, mintA, ownerTokenA, signer, 5_000_000);
    await mintTo(provider.connection, signer, mintB, ownerTokenB, signer, 5_000_000);

    tokenVaultStateA = findTokenVault(owner.publicKey, mintA);
    vaultTokenAccountA = findTokenVaultAta(owner.publicKey, mintA);
  });

  describe("SOL vault flow", () => {
    it("happy path: initialize + deposit + withdraw", async () => {
      await program.methods
        .initialize()
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const vaultAccount = await program.account.vaultState.fetch(vaultPda);
      assert.ok(vaultAccount.owner.equals(owner.publicKey));
      assert.equal(vaultAccount.bump, vaultBump);

      const depositAmount = new anchor.BN(0.5 * LAMPORTS_PER_SOL);
      const before = await provider.connection.getBalance(vaultPda);
      await program.methods
        .deposit(depositAmount)
        .accounts({
          depositor: owner.publicKey,
          vault: vaultPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      const after = await provider.connection.getBalance(vaultPda);
      assert.equal(after - before, depositAmount.toNumber());

      const withdrawAmount = new anchor.BN(0.1 * LAMPORTS_PER_SOL);
      await program.methods
        .withdraw(withdrawAmount)
        .accounts({ owner: owner.publicKey, vault: vaultPda })
        .rpc();

      const balanceAfterWithdraw = await provider.connection.getBalance(vaultPda);
      assert.isAtMost(
        balanceAfterWithdraw,
        after - withdrawAmount.toNumber(),
        "vault lamports should decrease after withdrawal"
      );
    });

    it("unauthorized: attacker cannot withdraw owner vault", async () => {
      const attacker = Keypair.generate();
      await airdropIfNeeded(attacker.publicKey, 0.5);
      const [attackerVaultPda] = findVault(attacker.publicKey);

      await expectFails(
        program.methods
          .withdraw(new anchor.BN(1_000))
          .accounts({ owner: attacker.publicKey, vault: attackerVaultPda })
          .signers([attacker])
          .rpc(),
        ["ConstraintSeeds", "AccountNotInitialized", "Unauthorized"]
      );
    });

    it("zero amount: rejects deposit and withdraw", async () => {
      await expectFails(
        program.methods
          .deposit(new anchor.BN(0))
          .accounts({
            depositor: owner.publicKey,
            vault: vaultPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
        ["ZeroAmount"]
      );

      await expectFails(
        program.methods
          .withdraw(new anchor.BN(0))
          .accounts({ owner: owner.publicKey, vault: vaultPda })
          .rpc(),
        ["ZeroAmount"]
      );
    });
  });

  describe("SPL token vault flow", () => {
    it("happy path: initialize token vault + deposit + withdraw", async () => {
      await program.methods
        .initializeTokenVault()
        .accounts({
          owner: owner.publicKey,
          mint: mintA,
          tokenVaultState: tokenVaultStateA,
          vaultTokenAccount: vaultTokenAccountA,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      await program.methods
        .depositToken(new anchor.BN(1_000_000))
        .accounts({
          depositor: owner.publicKey,
          mint: mintA,
          tokenVaultState: tokenVaultStateA,
          vaultTokenAccount: vaultTokenAccountA,
          depositorTokenAccount: ownerTokenA,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      await program.methods
        .withdrawToken(new anchor.BN(400_000))
        .accounts({
          owner: owner.publicKey,
          mint: mintA,
          tokenVaultState: tokenVaultStateA,
          vaultTokenAccount: vaultTokenAccountA,
          ownerTokenAccount: ownerTokenA,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const vaultToken = await getAccount(provider.connection, vaultTokenAccountA);
      assert.equal(vaultToken.amount.toString(), "600000");
    });

    it("unauthorized: attacker cannot withdraw token vault", async () => {
      const attacker = Keypair.generate();
      await airdropIfNeeded(attacker.publicKey, 0.5);

      const attackerTokenA = await createAssociatedTokenAccount(
        provider.connection,
        signer,
        mintA,
        attacker.publicKey
      );

      const attackerTokenVaultState = findTokenVault(attacker.publicKey, mintA);
      const attackerVaultAta = findTokenVaultAta(attacker.publicKey, mintA);

      await expectFails(
        program.methods
          .withdrawToken(new anchor.BN(1))
          .accounts({
            owner: attacker.publicKey,
            mint: mintA,
            tokenVaultState: attackerTokenVaultState,
            vaultTokenAccount: attackerVaultAta,
            ownerTokenAccount: attackerTokenA,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([attacker])
          .rpc(),
        ["ConstraintSeeds", "AccountNotInitialized", "Unauthorized"]
      );
    });

    it("invalid mint: rejects mismatched token accounts", async () => {
      await expectFails(
        program.methods
          .depositToken(new anchor.BN(1))
          .accounts({
            depositor: owner.publicKey,
            mint: mintA,
            tokenVaultState: tokenVaultStateA,
            vaultTokenAccount: vaultTokenAccountA,
            depositorTokenAccount: ownerTokenB,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc(),
        ["InvalidMint", "ConstraintRaw", "ConstraintTokenMint"]
      );

      await expectFails(
        program.methods
          .withdrawToken(new anchor.BN(1))
          .accounts({
            owner: owner.publicKey,
            mint: mintA,
            tokenVaultState: tokenVaultStateA,
            vaultTokenAccount: vaultTokenAccountA,
            ownerTokenAccount: ownerTokenB,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc(),
        ["InvalidMint", "ConstraintRaw", "ConstraintTokenMint"]
      );
    });

    it("zero amount: rejects token deposit and withdraw", async () => {
      await expectFails(
        program.methods
          .depositToken(new anchor.BN(0))
          .accounts({
            depositor: owner.publicKey,
            mint: mintA,
            tokenVaultState: tokenVaultStateA,
            vaultTokenAccount: vaultTokenAccountA,
            depositorTokenAccount: ownerTokenA,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc(),
        ["ZeroAmount"]
      );

      await expectFails(
        program.methods
          .withdrawToken(new anchor.BN(0))
          .accounts({
            owner: owner.publicKey,
            mint: mintA,
            tokenVaultState: tokenVaultStateA,
            vaultTokenAccount: vaultTokenAccountA,
            ownerTokenAccount: ownerTokenA,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc(),
        ["ZeroAmount"]
      );
    });
  });
});
