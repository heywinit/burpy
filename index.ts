import {
  Connection,
  Keypair,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import {
  createCloseAccountInstruction,
  createBurnInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import chalk from "chalk";

// ============================================================================
// Logger Utilities
// ============================================================================

class Logger {
  private prefix = "⚡ SOL INCINERATOR";

  header(title: string) {
    console.log(chalk.bold.cyan("\n" + "=".repeat(70)));
    console.log(chalk.bold.cyan(`${this.prefix} | ${title}`));
    console.log(chalk.bold.cyan("=".repeat(70) + "\n"));
  }

  success(message: string, details?: string) {
    console.log(
      chalk.green(`✓ ${message}`),
      details ? chalk.gray(`(${details})`) : ""
    );
  }

  info(message: string, details?: string) {
    console.log(
      chalk.blue(`ℹ ${message}`),
      details ? chalk.gray(`(${details})`) : ""
    );
  }

  warning(message: string, details?: string) {
    console.log(
      chalk.yellow(`⚠ ${message}`),
      details ? chalk.gray(`(${details})`) : ""
    );
  }

  error(message: string, details?: string) {
    console.log(
      chalk.red(`✗ ${message}`),
      details ? chalk.gray(`(${details})`) : ""
    );
  }

  stat(label: string, value: string | number, unit?: string) {
    console.log(
      chalk.cyan(`  ${label}:`),
      chalk.bold.white(`${value}${unit ? ` ${unit}` : ""}`)
    );
  }

  divider() {
    console.log(chalk.gray("-".repeat(70)));
  }
}

const logger = new Logger();

// ============================================================================
// Constants
// ============================================================================

const SOL_MINT = "So11111111111111111111111111111111111111112";
const BATCH_SIZE = 10;

// ============================================================================
// Token Account Interface
// ============================================================================

interface TokenAccount {
  pubkey: PublicKey;
  mint: string;
  amount: string;
  decimals: number;
  uiAmount: number;
}

// ============================================================================
// Main Script
// ============================================================================

async function burnAllTokens() {
  logger.header("TOKEN INCINERATOR - Burning All SPL Tokens");

  // Load environment variables
  const privateKeyString =
    process.env.SOLANA_PRIVATE_KEY || process.env.PRIVATE_KEY;
  const rpcUrl =
    process.env.SOLANA_RPC_URL ||
    process.env.RPC_URL ||
    "https://api.mainnet-beta.solana.com";

  if (!privateKeyString) {
    logger.error(
      "Missing SOLANA_PRIVATE_KEY or PRIVATE_KEY environment variable"
    );
    logger.info("Set it in .env file or as an environment variable");
    process.exit(1);
  }

  // Initialize connection and wallet
  const connection = new Connection(rpcUrl, "processed");
  let wallet: Keypair;

  try {
    const privateKeyBuffer = bs58.decode(privateKeyString);
    wallet = Keypair.fromSecretKey(privateKeyBuffer);
  } catch (error) {
    logger.error("Invalid private key format. Expected base58 encoded string.");
    process.exit(1);
  }

  logger.info("Wallet loaded", wallet.publicKey.toString());
  logger.info("RPC Endpoint", rpcUrl);

  // Fetch wallet balance
  const solBalance = await connection.getBalance(wallet.publicKey);
  logger.stat(
    "Current SOL Balance",
    (solBalance / LAMPORTS_PER_SOL).toFixed(6),
    "SOL"
  );
  logger.divider();

  // Get all token accounts
  logger.info("Scanning SPL token accounts...");
  const tokenAccountsResponse = await connection.getParsedTokenAccountsByOwner(
    wallet.publicKey,
    {
      programId: TOKEN_PROGRAM_ID,
    }
  );

  const allTokenAccounts: TokenAccount[] = tokenAccountsResponse.value
    .map((account) => {
      const data = (account.account.data as any).parsed?.info;
      return {
        pubkey: account.pubkey,
        mint: data.mint as string,
        amount: data.tokenAmount.amount as string,
        decimals: data.tokenAmount.decimals as number,
        uiAmount: data.tokenAmount.uiAmount as number,
      };
    })
    .filter((account) => {
      // Skip wrapped SOL
      return account.mint !== SOL_MINT;
    });

  logger.stat("Total token accounts found", allTokenAccounts.length);

  if (allTokenAccounts.length === 0) {
    logger.info("No SPL token accounts found to process");
    return;
  }

  // Separate tokens with balance and empty accounts
  const tokensWithBalance = allTokenAccounts.filter(
    (account) => account.amount !== "0"
  );
  const emptyAccounts = allTokenAccounts.filter(
    (account) => account.amount === "0"
  );

  logger.stat("Tokens with balance", tokensWithBalance.length);
  logger.stat("Empty accounts", emptyAccounts.length);
  logger.divider();

  // ============================================================================
  // Phase 1: Burn tokens with balance
  // ============================================================================

  if (tokensWithBalance.length > 0) {
    logger.header("PHASE 1: BURNING TOKENS");

    const burnBatches: TokenAccount[][] = [];
    for (let i = 0; i < tokensWithBalance.length; i += BATCH_SIZE) {
      burnBatches.push(tokensWithBalance.slice(i, i + BATCH_SIZE));
    }

    logger.stat("Burn batches", burnBatches.length);
    logger.stat("Batch size", `${BATCH_SIZE} tokens per transaction`);
    logger.divider();

    let totalBurned = 0;
    const burnSignatures: string[] = [];

    for (let batchIndex = 0; batchIndex < burnBatches.length; batchIndex++) {
      const batch = burnBatches[batchIndex];
      if (!batch) continue;

      logger.info(
        `\nBurn Batch ${batchIndex + 1}/${burnBatches.length}`,
        `${batch.length} tokens`
      );

      const instructions = [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 800000 }),
      ];

      for (const token of batch) {
        try {
          const mintPublicKey = new PublicKey(token.mint);
          const burnInstruction = createBurnInstruction(
            token.pubkey,
            mintPublicKey,
            wallet.publicKey,
            BigInt(token.amount)
          );
          instructions.push(burnInstruction);

          const displayAmount = token.uiAmount?.toFixed(6) || "0";
          logger.info(
            `  Preparing burn`,
            `${displayAmount} tokens (${token.mint.slice(0, 8)}...)`
          );
        } catch (error) {
          logger.error(
            `Failed to prepare burn for ${token.mint.slice(0, 8)}`,
            (error as Error).message
          );
        }
      }

      const { blockhash } = await connection.getLatestBlockhash("processed");

      const message = new TransactionMessage({
        instructions,
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
      }).compileToV0Message();

      const transaction = new VersionedTransaction(message);
      transaction.sign([wallet]);

      try {
        const signature = await connection.sendTransaction(transaction, {
          preflightCommitment: "processed",
          skipPreflight: false,
          maxRetries: 5,
        });

        logger.success(
          `Burn batch ${batchIndex + 1} submitted`,
          signature.slice(0, 16) + "..."
        );
        logger.info("View transaction", `https://solscan.io/tx/${signature}`);

        const confirmation = await connection.confirmTransaction(
          {
            blockhash,
            lastValidBlockHeight:
              (await connection.getBlockHeight("processed")) + 150,
            signature,
          },
          "processed"
        );

        if (confirmation.value.err) {
          logger.error(`Burn batch ${batchIndex + 1} failed`);
          continue;
        }

        logger.success(`Burn batch ${batchIndex + 1} confirmed`);
        burnSignatures.push(signature);
        totalBurned += batch.length;

        if (batchIndex < burnBatches.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      } catch (error) {
        logger.error(
          `Burn batch ${batchIndex + 1} failed`,
          (error as Error).message
        );
      }
    }

    logger.divider();
    logger.stat("Total tokens burned", totalBurned);
    logger.stat("Successful burn batches", burnSignatures.length);
    logger.divider();
  }

  // ============================================================================
  // Phase 2: Close all token accounts (free up rent)
  // ============================================================================

  logger.header("PHASE 2: CLOSING TOKEN ACCOUNTS (FREEING RENT)");

  const accountsToClose = [...tokensWithBalance, ...emptyAccounts];

  if (accountsToClose.length === 0) {
    logger.info("No token accounts to close");
    return;
  }

  const closeBatches: TokenAccount[][] = [];
  for (let i = 0; i < accountsToClose.length; i += BATCH_SIZE) {
    closeBatches.push(accountsToClose.slice(i, i + BATCH_SIZE));
  }

  logger.stat("Close batches", closeBatches.length);
  logger.stat("Batch size", `${BATCH_SIZE} accounts per transaction`);
  logger.divider();

  let totalClosed = 0;
  const closeSignatures: string[] = [];

  for (let batchIndex = 0; batchIndex < closeBatches.length; batchIndex++) {
    const batch = closeBatches[batchIndex];
    if (!batch) continue;

    logger.info(
      `\nClose Batch ${batchIndex + 1}/${closeBatches.length}`,
      `${batch.length} accounts`
    );

    const instructions = [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 800000 }),
    ];

    for (const token of batch) {
      try {
        const closeInstruction = createCloseAccountInstruction(
          token.pubkey,
          wallet.publicKey,
          wallet.publicKey
        );
        instructions.push(closeInstruction);
        logger.info(`  Preparing close`, `${token.mint.slice(0, 8)}...`);
      } catch (error) {
        logger.error(
          `Failed to prepare close for ${token.mint.slice(0, 8)}`,
          (error as Error).message
        );
      }
    }

    const { blockhash } = await connection.getLatestBlockhash("processed");

    const message = new TransactionMessage({
      instructions,
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(message);
    transaction.sign([wallet]);

    try {
      const signature = await connection.sendTransaction(transaction, {
        preflightCommitment: "processed",
        skipPreflight: false,
        maxRetries: 5,
      });

      logger.success(
        `Close batch ${batchIndex + 1} submitted`,
        signature.slice(0, 16) + "..."
      );
      logger.info("View transaction", `https://solscan.io/tx/${signature}`);

      const confirmation = await connection.confirmTransaction(
        {
          blockhash,
          lastValidBlockHeight:
            (await connection.getBlockHeight("processed")) + 150,
          signature,
        },
        "processed"
      );

      if (confirmation.value.err) {
        logger.error(`Close batch ${batchIndex + 1} failed`);
        continue;
      }

      logger.success(`Close batch ${batchIndex + 1} confirmed`);
      closeSignatures.push(signature);
      totalClosed += batch.length;

      if (batchIndex < closeBatches.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch (error) {
      logger.error(
        `Close batch ${batchIndex + 1} failed`,
        (error as Error).message
      );
    }
  }

  // ============================================================================
  // Final Summary
  // ============================================================================

  logger.header("INCINERATOR COMPLETE");

  // Check final balance
  const finalSolBalance = await connection.getBalance(wallet.publicKey);
  const solRecovered = (finalSolBalance - solBalance) / LAMPORTS_PER_SOL;

  logger.stat("Total tokens burned", tokensWithBalance.length);
  logger.stat("Total accounts closed", totalClosed);
  logger.stat("SOL recovered from rent", solRecovered.toFixed(6), "SOL");
  logger.stat(
    "Final SOL balance",
    (finalSolBalance / LAMPORTS_PER_SOL).toFixed(6),
    "SOL"
  );
  logger.divider();

  if (closeSignatures.length > 0) {
    logger.info("All transactions completed successfully!");
    logger.info("Hidden SOL has been freed from token account rent");
  }
}

// Run the script
burnAllTokens().catch((error) => {
  logger.error("Fatal error", error.message);
  console.error(error);
  process.exit(1);
});
