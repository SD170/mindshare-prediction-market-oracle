# Oracle Pipeline

TypeScript service that posts market resolutions to the SettlementOracle contract.

## Setup

```bash
npm install
```

## Configuration

Create `.env`:
```env
RPC_URL=https://sepolia.base.org
PRIVATE_KEY=0xYourPrivateKey
API_URL=http://localhost:3001
```

Contract addresses are fetched from the backend API. Optionally set `config/contracts.json` as fallback.

## Run

```bash
npm run dev
```

## Process

1. Loads leaderboard from API
2. Randomizes using Fisher-Yates shuffle
3. Saves snapshot to database
4. Determines winners for each market
5. Signs resolutions (EIP-191)
6. Posts to SettlementOracle contract
