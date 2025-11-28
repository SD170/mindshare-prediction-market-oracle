/// <reference types="node" />
import { ethers } from "ethers";
import { getSigner, config, MarketConfig, getContracts } from "./config.ts";
import {
  determineWinner,
  generateBlobHash,
  Project,
} from "./utils.ts";

// SettlementOracle ABI (only the functions we need)
const SETTLEMENT_ORACLE_ABI = [
  "function post((bytes32 marketId, uint8 winner, bytes32 snapshotHash, uint64 resolvedAt, uint64 challengeUntil, uint256 nonce), bytes sig) external",
  "function getSigner() external view returns (address)",
] as const;

const MARKET_FACTORY_ABI = [
  "function computeMarketId(bytes32 questionHash, uint64 lockTime) public view returns (bytes32)",
] as const;

export interface Resolution {
  marketId: string;
  winner: 1 | 2;
  snapshotHash: string;
  resolvedAt: number;
  challengeUntil: number;
  nonce: bigint;
}

/**
 * Load leaderboard snapshot from API source of truth (gets highest index for today)
 */
export async function loadLeaderboardSnapshot(): Promise<Project[]> {
  const response = await fetch(`${config.apiBaseUrl}/api/leaderboard/today`);
  if (!response.ok) {
    throw new Error(`Failed to load leaderboard: ${response.statusText}`);
  }
  return (await response.json()) as Project[];
}

/**
 * Save a randomized leaderboard snapshot (creates new index for today)
 */
export async function saveLeaderboardSnapshot(entries: Project[]): Promise<void> {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  console.log(`Saving ${entries.length} entries to API at ${config.apiBaseUrl}...`);
  
  try {
    const response = await fetch(`${config.apiBaseUrl}/api/leaderboard/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: today, entries }),
      signal: AbortSignal.timeout(30000), // 30 second timeout
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to save leaderboard snapshot: ${response.status} ${response.statusText} - ${error}`);
    }
    
    const result = await response.json();
    console.log(`✅ Saved leaderboard snapshot: date=${result.date}, index=${result.index}, count=${result.count}`);
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout while saving leaderboard snapshot. API may be unresponsive.`);
    }
    if (error.cause?.code === 'UND_ERR_SOCKET') {
      throw new Error(`Connection closed while saving leaderboard snapshot. Is the API server running at ${config.apiBaseUrl}?`);
    }
    throw error;
  }
}

async function loadMarkets(): Promise<MarketConfig[]> {
  const response = await fetch(`${config.apiBaseUrl}/api/markets`);
  if (!response.ok) {
    throw new Error(`Failed to load markets: ${response.statusText}`);
  }
  return (await response.json()) as MarketConfig[];
}

/**
 * Compute market ID from question hash and lock time
 */
export async function computeMarketId(
  questionHash: string,
  lockTime: number
): Promise<string> {
  const signer = getSigner();
  const contracts = await getContracts();
  const factory = new ethers.Contract(
    contracts.marketFactory,
    MARKET_FACTORY_ABI,
    signer
  );

  const marketId = await factory.computeMarketId(
    questionHash,
    lockTime
  );
  return marketId;
}

/**
 * Create and sign a resolution for a market
 */
export async function createResolution(
  market: MarketConfig,
  randomizedLeaderboard: Project[],
  blockTimestamp: number
): Promise<{ resolution: Resolution; signature: string }> {
  if (!market.marketId) {
    throw new Error(`Market ID not set for market: ${market.questionHash}`);
  }

  const { winner, snapshotHash } = determineWinner(
    market,
    randomizedLeaderboard
  );

  // Use block timestamp (must be <= block.timestamp per contract requirement)
  const resolvedAt = blockTimestamp;
  const challengeUntil = 0; // Reserved for future optimistic upgrades
  const nonce = BigInt(resolvedAt); // Use timestamp as nonce

  const resolution: Resolution = {
    marketId: market.marketId,
    winner,
    snapshotHash,
    resolvedAt,
    challengeUntil,
    nonce,
  };

  // Generate blob hash (matches contract logic)
  const signer = getSigner();
  const contracts = await getContracts();
  const oracleAddress = contracts.settlementOracle;

  const blob = generateBlobHash(
    resolution.marketId,
    resolution.winner,
    resolution.snapshotHash,
    resolution.resolvedAt,
    resolution.challengeUntil,
    resolution.nonce,
    oracleAddress
  );

  // Sign with EIP-191 prefix (signMessage automatically adds the prefix)
  // This matches MessageHashUtils.toEthSignedMessageHash(blob) in the contract
  const signature = await signer.signMessage(ethers.getBytes(blob));

  return { resolution, signature };
}

/**
 * Post resolution to SettlementOracle
 */
export async function postResolution(
  resolution: Resolution,
  signature: string
): Promise<void> {
  const signer = getSigner();
  const contracts = await getContracts();
  const oracle = new ethers.Contract(
    contracts.settlementOracle,
    SETTLEMENT_ORACLE_ABI,
    signer
  );

  const resolutionTuple = [
    resolution.marketId,
    resolution.winner,
    resolution.snapshotHash,
    resolution.resolvedAt,
    resolution.challengeUntil,
    resolution.nonce,
  ] as const;

  const tx = await oracle.post(resolutionTuple, signature);
  console.log(`Posted resolution for market ${resolution.marketId}: ${tx.hash}`);
  await tx.wait();
  console.log(`Resolution confirmed for market ${resolution.marketId}`);
}

/**
 * Process all markets and post resolutions
 */
export async function processMarkets(): Promise<void> {
  console.log("Loading leaderboard snapshot (latest index for today)...");
  const leaderboardSnapshot = await loadLeaderboardSnapshot();
  console.log(`Loaded leaderboard with ${leaderboardSnapshot.length} projects`);
  console.log("Top 10:", leaderboardSnapshot.slice(0, 10).map(p => p.name).join(", "));
  
  // Log key projects for debugging
  console.log("\n📊 Key projects in loaded snapshot:");
  ["Scroll", "Morpho", "Jupiter", "Fantom", "Gains Network", "Drift Protocol"].forEach(projectName => {
    const project = leaderboardSnapshot.find(p => p.name === projectName);
    if (project) {
      console.log(`  ${projectName}: Rank ${project.rank} (${project.rank <= 10 ? '✅ IN TOP 10' : '❌ NOT IN TOP 10'})`);
    }
  });
  
  // NOTE: We use the leaderboard snapshot AS-IS (already randomized by admin regeneration)
  // The oracle does NOT randomize again - it uses whatever snapshot is in the database

  console.log("Loading markets from API...");
  const markets = await loadMarkets();
  if (markets.length === 0) {
    console.log("No markets found to process.");
    return;
  }

  // Get current block timestamp from blockchain
  const provider = getSigner().provider!;
  const block = await provider.getBlock("latest");
  const blockTimestamp = block?.timestamp ?? Math.floor(Date.now() / 1000);
  
  console.log(`\nCurrent block timestamp: ${blockTimestamp}`);
  console.log(`Processing ${markets.length} markets...`);

  let processed = 0;
  let skipped = 0;

  for (const market of markets) {
    try {
      const marketName = market.type === "top10" 
        ? `Top-10: ${market.projectName}`
        : `H2H: ${market.projectA} vs ${market.projectB}`;
      
      console.log(`\nProcessing market: ${marketName}`);
      console.log(`  Question Hash: ${market.questionHash}`);
      console.log(`  Resolve Time: ${market.resolveTime} (${new Date(market.resolveTime * 1000).toISOString()})`);
      
      // Check if market is ready (resolveTime has passed)
      if (blockTimestamp < market.resolveTime) {
        const waitTime = market.resolveTime - blockTimestamp;
        const waitHours = Math.floor(waitTime / 3600);
        const waitMinutes = Math.floor((waitTime % 3600) / 60);
        const waitSeconds = waitTime % 60;
        const etaDate = new Date(market.resolveTime * 1000);
        
        console.log(`  ⏳ Market not ready yet`);
        console.log(`  Current time: ${blockTimestamp} (${new Date(blockTimestamp * 1000).toISOString()})`);
        console.log(`  ETA: ${waitTime} seconds (${waitHours}h ${waitMinutes}m ${waitSeconds}s)`);
        console.log(`  Ready at: ${etaDate.toISOString()}`);
        skipped++;
        continue;
      }
      
      // Compute market ID if not already set
      if (!market.marketId) {
        market.marketId = await computeMarketId(market.questionHash, market.lockTime);
        console.log(`Computed market ID: ${market.marketId}`);
      }

      // Create and sign resolution (use block timestamp)
      const { resolution, signature } = await createResolution(
        market,
        leaderboardSnapshot,
        blockTimestamp
      );

      console.log(`  ✅ Market ready for resolution`);
      console.log(`  Winner: ${resolution.winner} (${market.type === 'top10' 
        ? (resolution.winner === 1 ? 'Yes - In Top 10' : 'No - Not in Top 10')
        : (resolution.winner === 1 ? market.projectA : market.projectB)})`);
      console.log(`  Snapshot hash: ${resolution.snapshotHash}`);
      console.log(`  Resolved at: ${resolution.resolvedAt} (${new Date(resolution.resolvedAt * 1000).toISOString()})`);

      // Post resolution
      await postResolution(resolution, signature);
      processed++;
    } catch (error) {
      console.error(`Error processing market ${market.questionHash}:`, error);
      // Continue with other markets instead of throwing
      if (error instanceof Error && error.message.includes("time")) {
        console.log(`⏳ Market not ready (time check failed)`);
        skipped++;
      } else {
        throw error;
      }
    }
  }

  console.log(`\n✅ Processed ${processed} markets, skipped ${skipped} (not ready yet)`);
  if (skipped > 0) {
    console.log(`\nNote: Some markets are not ready yet. Wait until resolveTime has passed and run again.`);
  }
}

