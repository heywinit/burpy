import {
    Connection,
    Keypair,
    ComputeBudgetProgram,
    TransactionMessage,
    VersionedTransaction,
    LAMPORTS_PER_SOL,
  } from "@solana/web3.js"
  import { createCloseAccountInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token"
  import bs58 from "bs58"
  import chalk from "chalk"
  
  // ============================================================================
  // Logger Utilities
  // ============================================================================
  
  class Logger {
    private prefix = "⚡ SOL INCINERATOR"
  
    header(title: string) {
      console.log(chalk.bold.cyan("\n" + "=".repeat(70)))
      console.log(chalk.bold.cyan(`${this.prefix} | ${title}`))
      console.log(chalk.bold.cyan("=".repeat(70) + "\n"))
    }
  
    success(message: string, details?: string) {
      console.log(chalk.green(`✓ ${message}`), details ? chalk.gray(`(${details})`) : "")
    }
  
    info(message: string, details?: string) {
      console.log(chalk.blue(`ℹ ${message}`), details ? chalk.gray(`(${details})`) : "")
    }
  
    warning(message: string, details?: string) {
      console.log(chalk.yellow(`⚠ ${message}`), details ? chalk.gray(`(${details})`) : "")
    }
  
    error(message: string, details?: string) {
      console.log(chalk.red(`✗ ${message}`), details ? chalk.gray(`(${details})`) : "")
    }
  
    stat(label: string, value: string | number, unit?: string) {
      console.log(chalk.cyan(`  ${label}:`), chalk.bold.white(`${value}${unit ? ` ${unit}` : ""}`))
    }
  
    divider() {
      console.log(chalk.gray("-".repeat(70)))
    }
  }
  
  const logger = new Logger()
  
  // ============================================================================
  // Constants
  // ============================================================================
  
  const SOL_MINT = "So11111111111111111111111111111111111111112"
  const BATCH_SIZE = 10
  
  // ============================================================================
  // Token Blacklist (Common worthless/spam tokens)
  // ============================================================================
  
  const TOKEN_BLACKLIST = [
    "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", // Common spam
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC (keep)
    "So11111111111111111111111111111111111111112", // WSOL (keep)
  ]
  
  // ============================================================================
  // Jupiter Swap Integration
  // ============================================================================
  
  interface JupiterQuote {
    inputMint: string
    inAmount: string
    outputMint: string
    outAmount: string
    otherAmountThreshold: string
    slippageBps: number
    priceImpactPct: string
    routePlan: Array<{
      swapInfo: {
        ammKey: string
        label: string
        inputMint: string
        outputMint: string
        inAmount: string
        outAmount: string
      }
      percent: number
    }>
  }
  
  async function getJupiterQuote(inputMint: string, outputMint: string, amount: string): Promise<JupiterQuote | null> {
    try {
      const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount,
        slippageBps: "500", // 5% slippage
      })
  
      const response = await fetch(`https://quote-api.jup.ag/v6/quote?${params.toString()}`)
  
      if (!response.ok) {
        return null
      }
  
      return (await response.json()) as JupiterQuote
    } catch (error) {
      return null
    }
  }
  
  async function executeJupiterSwap(
    connection: Connection,
    wallet: Keypair,
    inputMint: string,
    outputMint: string,
    amount: string,
    tokenSymbol: string,
  ): Promise<string | null> {
    try {
      const quote = await getJupiterQuote(inputMint, outputMint, amount)
  
      if (!quote) {
        logger.warning(`No liquidity for ${tokenSymbol}, will close account`)
        return null
      }
  
      const outAmount = Number.parseFloat(quote.outAmount) / 10 ** 9
      logger.info(`Quote for ${tokenSymbol}`, `${outAmount.toFixed(6)} SOL`)
  
      const swapRequest = {
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
      }
  
      const response = await fetch("https://quote-api.jup.ag/v6/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(swapRequest),
      })
  
      if (!response.ok) {
        return null
      }
  
      const swapData = (await response.json()) as { swapTransaction: string }
  
      if (!swapData.swapTransaction) {
        return null
      }
  
      const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, "base64"))
      tx.sign([wallet])
  
      const signature = await connection.sendTransaction(tx, {
        preflightCommitment: "processed",
        skipPreflight: false,
        maxRetries: 3,
      })
  
      logger.success(`Swapped ${tokenSymbol}`, signature.slice(0, 16) + "...")
  
      await connection.confirmTransaction(
        {
          signature,
          lastValidBlockHeight: (await connection.getBlockHeight("processed")) + 150,
          blockhash: (await connection.getLatestBlockhash("processed")).blockhash,
        },
        "processed",
      )
  
      return signature
    } catch (error) {
      logger.warning(`Swap failed for ${tokenSymbol}`)
      return null
    }
  }
  
  // ============================================================================
  // Main Script
  // ============================================================================
  
  async function burnLowValueTokens() {
    logger.header("TOKEN INCINERATOR - Swapping All Tokens to SOL")
  
    // Load environment variables
    const privateKeyString = process.env.SOLANA_PRIVATE_KEY
    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com"
  
    if (!privateKeyString) {
      logger.error("Missing SOLANA_PRIVATE_KEY environment variable")
      process.exit(1)
    }
  
    // Initialize connection and wallet
    const connection = new Connection(rpcUrl, "processed")
    const privateKeyBuffer = bs58.decode(privateKeyString)
    const wallet = Keypair.fromSecretKey(privateKeyBuffer)
  
    logger.info("Wallet loaded", wallet.publicKey.toString().slice(0, 8) + "...")
  
    // Fetch wallet balance
    const solBalance = await connection.getBalance(wallet.publicKey)
    logger.stat("Current SOL Balance", (solBalance / LAMPORTS_PER_SOL).toFixed(4), "SOL")
  
    // Get all token accounts
    logger.info("Scanning SPL token accounts...")
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      programId: TOKEN_PROGRAM_ID,
    })
  
    const tokensToSwap = tokenAccounts.value
      .filter((account) => {
        const data = (account.account.data as any).parsed?.info
        const mint = data.mint as string
        const tokenAmount = data.tokenAmount
  
        // Skip SOL (wrapped SOL)
        if (mint === SOL_MINT) {
          return false
        }
  
        // Skip zero-balance
        return tokenAmount && tokenAmount.amount !== "0"
      })
      .map((account) => {
        const data = (account.account.data as any).parsed?.info
        return {
          mint: data.mint as string,
          ata: account.pubkey,
          amount: data.tokenAmount.amount as string,
          decimals: data.tokenAmount.decimals as number,
        }
      })
  
    logger.stat("Tokens to swap", tokensToSwap.length)
  
    if (tokensToSwap.length === 0) {
      logger.info("No tokens found to swap")
      return
    }
  
    logger.divider()
  
    const swappedTokens: typeof tokensToSwap = []
    const tokensToClose: typeof tokensToSwap = []
  
    for (const token of tokensToSwap) {
      const swapSig = await executeJupiterSwap(
        connection,
        wallet,
        token.mint,
        SOL_MINT,
        token.amount,
        token.mint.slice(0, 8),
      )
  
      if (swapSig) {
        swappedTokens.push(token)
        logger.info("View swap", `https://solscan.io/tx/${swapSig}`)
      } else {
        tokensToClose.push(token)
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  
    logger.divider()
    logger.stat("Successfully swapped", swappedTokens.length)
    logger.stat("No liquidity (will close)", tokensToClose.length)
  
    const accountsToClose = [...swappedTokens, ...tokensToClose]
  
    if (accountsToClose.length === 0) {
      logger.info("No tokens to process")
      return
    }
  
    logger.header("CLOSING TOKEN ACCOUNTS (BATCHED)")
  
    const batches: (typeof accountsToClose)[] = []
    for (let i = 0; i < accountsToClose.length; i += BATCH_SIZE) {
      batches.push(accountsToClose.slice(i, i + BATCH_SIZE))
    }
  
    logger.stat("Total batches", batches.length)
    logger.stat("Batch size", `${BATCH_SIZE} tokens per transaction`)
  
    let totalClosed = 0
    const batchSignatures: string[] = []
  
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex]
      if (!batch) continue
      logger.info(`\nBatch ${batchIndex + 1}/${batches.length}`, `${batch.length} tokens`)
  
      const instructions = [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 800000 }),
      ]
  
      for (const token of batch) {
        try {
          const closeInstruction = createCloseAccountInstruction(token.ata, wallet.publicKey, wallet.publicKey)
          instructions.push(closeInstruction)
        } catch (error) {
          logger.error(`Failed to prepare close for ${token.mint.slice(0, 8)}`)
        }
      }
  
      const { blockhash } = await connection.getLatestBlockhash("processed")
  
      const message = new TransactionMessage({
        instructions,
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
      }).compileToV0Message()
  
      const transaction = new VersionedTransaction(message)
      transaction.sign([wallet])
  
      try {
        const signature = await connection.sendTransaction(transaction, {
          preflightCommitment: "processed",
          skipPreflight: false,
          maxRetries: 5,
        })
  
        logger.success(`Batch ${batchIndex + 1} submitted`, signature.slice(0, 16) + "...")
  
        const confirmation = await connection.confirmTransaction(
          {
            blockhash,
            lastValidBlockHeight: (await connection.getBlockHeight("processed")) + 150,
            signature,
          },
          "processed",
        )
  
        if (confirmation.value.err) {
          logger.error(`Batch ${batchIndex + 1} failed`)
          continue
        }
  
        logger.success(`Batch ${batchIndex + 1} confirmed`)
        logger.info("View batch", `https://solscan.io/tx/${signature}`)
  
        batchSignatures.push(signature)
        totalClosed += batch.length
  
        if (batchIndex < batches.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
      } catch (error) {
        logger.error(`Batch ${batchIndex + 1} failed`, (error as Error).message)
      }
    }
  
    logger.header("INCINERATOR COMPLETE")
    logger.stat("Total accounts closed", totalClosed)
    logger.stat("Total batches", batchSignatures.length)
    logger.divider()
  }
  
  // Run the script
  burnLowValueTokens().catch((error) => {
    logger.error("Fatal error", error.message)
    console.error(error)
    process.exit(1)
  })
  