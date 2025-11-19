import { ethers } from "ethers";
import { MarketConfig } from "./config.ts";

export interface Project {
  name: string;
  rank: number;
  score: number;
  logo: string;
}

/**
 * Shuffle array using Fisher-Yates algorithm
 */
export function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Randomize leaderboard by shuffling and updating ranks
 */
export function randomizeLeaderboard(leaderboard: Project[]): Project[] {
  const shuffled = shuffleArray(leaderboard);
  return shuffled.map((project, index) => ({
    ...project,
    rank: index + 1,
  }));
}

/**
 * Generate keccak256 hash of JSON string
 */
export function hashJson(json: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(json));
}

/**
 * Determine winner for a market based on randomized leaderboard
 */
export function determineWinner(
  market: MarketConfig,
  randomizedLeaderboard: Project[]
): { winner: 1 | 2; snapshotHash: string } {
  const snapshotJson = JSON.stringify(randomizedLeaderboard);
  const snapshotHash = hashJson(snapshotJson);

  if (market.type === "top10") {
    const project = randomizedLeaderboard.find(
      (p) => p.name === market.projectName
    );
    if (!project) {
      throw new Error(`Project ${market.projectName} not found in leaderboard`);
    }
    // Winner 1 = in top 10, Winner 2 = not in top 10
    const winner: 1 | 2 = project.rank <= 10 ? 1 : 2;
    return { winner, snapshotHash };
  } else if (market.type === "h2h") {
    const projectA = randomizedLeaderboard.find(
      (p) => p.name === market.projectA
    );
    const projectB = randomizedLeaderboard.find(
      (p) => p.name === market.projectB
    );

    if (!projectA || !projectB) {
      throw new Error(
        `Projects not found: ${market.projectA} or ${market.projectB}`
      );
    }

    // Winner 1 = projectA (lower rank), Winner 2 = projectB (higher rank)
    const winner: 1 | 2 = projectA.rank < projectB.rank ? 1 : 2;
    return { winner, snapshotHash };
  } else {
    throw new Error(`Unknown market type: ${market.type}`);
  }
}

/**
 * Generate blob hash (before EIP-191 prefix) - matches contract logic
 */
export function generateBlobHash(
  marketId: string,
  winner: number,
  snapshotHash: string,
  resolvedAt: number,
  challengeUntil: number,
  nonce: bigint,
  oracleAddress: string
): string {
  const typeHash = ethers.keccak256(
    ethers.toUtf8Bytes(
      "Resolve(bytes32 marketId,uint8 winner,bytes32 snapshotHash,uint64 resolvedAt,uint64 challengeUntil,uint256 nonce,address this)"
    )
  );

  // Encode all fields together (matches contract's abi.encode)
  const blob = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "uint8", "bytes32", "uint64", "uint64", "uint256", "address"],
      [
        typeHash,
        marketId,
        winner,
        snapshotHash,
        resolvedAt,
        challengeUntil,
        nonce,
        oracleAddress,
      ]
    )
  );

  return blob;
}

