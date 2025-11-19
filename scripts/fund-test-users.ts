/// <reference types="node" />
import { ethers } from "ethers";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface TestUser {
  name: string;
  privateKey: string;
}

const configPath = join(__dirname, "../config/test-users.json");
const contractsPath = join(__dirname, "../config/contracts.json");

const STAKE_TOKEN_ABI = [
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
] as const;

// Default balance: 1000 tokens
const DEFAULT_BALANCE = "1000000000000000000000";

async function fundTestUsers() {
  const rpcUrl = process.env.RPC_URL || "https://sepolia.base.org";
  const funderPrivateKey = process.env.PRIVATE_KEY;
  
  if (!funderPrivateKey) {
    throw new Error("PRIVATE_KEY not set in .env file");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const funder = new ethers.Wallet(funderPrivateKey, provider);
  
  const testUsers: TestUser[] = JSON.parse(
    readFileSync(configPath, "utf-8")
  );
  
  const contracts: { stakeToken: string } = JSON.parse(
    readFileSync(contractsPath, "utf-8")
  );

  const stakeToken = new ethers.Contract(
    contracts.stakeToken,
    STAKE_TOKEN_ABI,
    funder
  );

  console.log("💰 Funding test users with StakeToken...\n");
  console.log(`Funder: ${funder.address}`);
  console.log(`StakeToken: ${contracts.stakeToken}`);
  console.log(`Default balance: ${ethers.formatEther(DEFAULT_BALANCE)} tokens per user\n`);

  const targetBalance = BigInt(DEFAULT_BALANCE);

  for (const user of testUsers) {
    if (user.privateKey === "0x0000000000000000000000000000000000000000000000000000000000000000") {
      console.log(`⏭️  Skipping ${user.name} - private key not set`);
      continue;
    }

    try {
      // Derive address from private key
      const userWallet = new ethers.Wallet(user.privateKey, provider);
      const userAddress = userWallet.address;
      
      console.log(`\n👤 ${user.name}`);
      console.log(`   Address: ${userAddress}`);

      const balance = await stakeToken.balanceOf(userAddress);
      
      if (balance >= targetBalance) {
        console.log(`   ✅ Already has sufficient balance: ${ethers.formatEther(balance)} tokens`);
        continue;
      }

      const amountNeeded = targetBalance - balance;
      console.log(`   💸 Funding...`);
      console.log(`   Current balance: ${ethers.formatEther(balance)} tokens`);
      console.log(`   Adding: ${ethers.formatEther(amountNeeded)} tokens`);

      const tx = await stakeToken.transfer(userAddress, amountNeeded);
      console.log(`   Transaction: ${tx.hash}`);
      await tx.wait();
      console.log(`   ✅ Funded successfully`);
    } catch (error) {
      console.error(`   ❌ Error funding ${user.name}:`, error);
    }
  }

  console.log("✅ Funding complete!");
}

fundTestUsers().catch(console.error);

