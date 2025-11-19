/// <reference types="node" />
import { ethers } from "ethers";
import dotenv from "dotenv";
import contracts from "../config/contracts.json" assert { type: "json" };

dotenv.config();

export interface ContractAddresses {
  settlementOracle: string;
  marketFactory: string;
  stakeToken: string;
}

export interface MarketConfig {
  type: "top10" | "h2h";
  projectName?: string;
  projectA?: string;
  projectB?: string;
  lockTime: number;
  resolveTime: number;
  questionHash: string;
  marketId?: string;
  marketAddress?: string;
}

let cachedContracts: ContractAddresses | null = contracts as ContractAddresses;

export const config = {
  rpcUrl: process.env.RPC_URL || "https://sepolia.base.org",
  privateKey: process.env.PRIVATE_KEY || "",
  contracts: contracts as ContractAddresses,
  apiBaseUrl: process.env.API_URL || "http://localhost:3001",
};

export function getProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(config.rpcUrl);
}

export function getSigner(): ethers.Wallet {
  if (!config.privateKey) {
    throw new Error("PRIVATE_KEY not set in environment variables");
  }
  return new ethers.Wallet(config.privateKey, getProvider());
}

export async function getContracts(): Promise<ContractAddresses> {
  if (config.apiBaseUrl) {
    try {
      const response = await fetch(`${config.apiBaseUrl}/api/contracts`);
      if (response.ok) {
        const data: Array<{ type: string; address: string }> = await response.json();
        const contractsMap: Partial<ContractAddresses> = { ...(cachedContracts || {}) };
        for (const entry of data) {
          if (entry.type === "settlementOracle") contractsMap.settlementOracle = entry.address;
          if (entry.type === "marketFactory") contractsMap.marketFactory = entry.address;
          if (entry.type === "stakeToken") contractsMap.stakeToken = entry.address;
        }
        if (contractsMap.settlementOracle && contractsMap.marketFactory && contractsMap.stakeToken) {
          cachedContracts = contractsMap as ContractAddresses;
        }
      }
    } catch (error) {
      console.error("Failed to fetch contracts from API, using local config", error);
    }
  }

  if (!cachedContracts) {
    throw new Error("Contract addresses not configured");
  }
  return cachedContracts;
}

