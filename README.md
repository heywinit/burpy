# burpy

A Solana token incinerator that burns all SPL tokens and closes token accounts to free up hidden SOL (rent).

## Features

- Burns all SPL tokens with balance
- Closes token accounts to recover rent (hidden SOL)
- Batched transactions for efficiency

## Installation

```bash
bun install
```

## Configuration

1. Copy the example environment file:

```bash
cp .env.example .env
```

2. Edit `.env` and add your private key and RPC URL:

```env
SOLANA_PRIVATE_KEY=your_base58_encoded_private_key_here
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
```

## Usage

Run the script:

```bash
bun run index.ts
```

The script will:

1. **Phase 1**: Burn all SPL tokens that have a balance
2. **Phase 2**: Close all token accounts (both empty and newly emptied) to recover rent

## How It Works

1. Scans your wallet for all SPL token accounts
2. Separates tokens with balance from empty accounts
3. Burns all tokens with balance in batched transactions
4. Closes all token accounts to free up the rent (hidden SOL)
5. Shows a summary of SOL recovered

## Environment Variables

- `SOLANA_PRIVATE_KEY` or `PRIVATE_KEY`: Your wallet's private key (base58 encoded)
- `SOLANA_RPC_URL` or `RPC_URL`: Solana RPC endpoint (defaults to mainnet-beta)

## Safety

**Warning**: This script permanently burns tokens and closes accounts. Make sure you want to do this before running!
