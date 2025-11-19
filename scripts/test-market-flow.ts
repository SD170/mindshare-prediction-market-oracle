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

interface MarketConfig {
  type: "top10" | "h2h";
  marketAddress: string;
  marketId?: string;
}

const configPath = join(__dirname, "../config/test-users.json");
const contractsPath = join(__dirname, "../config/contracts.json");
const API_BASE = process.env.API_URL || "http://localhost:3001";

async function getContractAddresses() {
  const fallback = JSON.parse(readFileSync(contractsPath, "utf-8")) as { [key: string]: string };
  try {
    const response = await fetch(`${API_BASE}/api/contracts`);
    if (!response.ok) {
      return fallback;
    }
    const data = await response.json();
    const map = { ...fallback };
    for (const entry of data) {
      map[entry.type] = entry.address;
    }
    return map;
  } catch (error) {
    console.error("Failed to fetch contracts from API, using fallback", error);
    return fallback;
  }
}

const STAKE_TOKEN_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
] as const;

const MARKET_ABI = [
  "function deposit(uint8 outcome, uint256 amount) external",
  "function close() external",
  "function settle() external",
  "function redeem() external",
  "function phase() external view returns (uint8)",
  "function pools() external view returns (uint128 A, uint128 B)",
  "function a(address) external view returns (uint128 aClaims, uint128 bClaims, bool redeemed)",
] as const;

async function testMarketFlow() {
  const rpcUrl = process.env.RPC_URL || "https://sepolia.base.org";
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const testUsers: TestUser[] = JSON.parse(
    readFileSync(configPath, "utf-8")
  );
  
  const response = await fetch(`${API_BASE}/api/markets`);
  const markets: MarketConfig[] = await response.json();
  const contractAddresses = await getContractAddresses();

  // Use first market for testing
  const testMarket = markets[0];
  if (!testMarket.marketAddress) {
    throw new Error("No market address found in config");
  }

  console.log("🧪 Testing Market Flow\n");
  console.log(`Market: ${testMarket.marketAddress}`);
  console.log(`Type: ${testMarket.type}\n`);

  const market = new ethers.Contract(
    testMarket.marketAddress,
    MARKET_ABI,
    provider
  );

  // Step 1: Check phase and approve tokens
  const phaseResult = await (market.phase() as Promise<bigint | number>);
  const phase = typeof phaseResult === 'bigint' ? Number(phaseResult) : phaseResult;
  console.log(`Current phase: ${phase} (0=Trading, 1=Locked, 2=Resolved, 3=Cancelled)\n`);

  if (phase !== 0) {
    console.log("⚠️  Market is not in Trading phase. Cannot deposit.");
    return;
  }

  // Step 2: Users deposit
  console.log("📥 Step 1: Depositing...\n");
  
  const depositAmount = ethers.parseEther("100"); // 100 tokens per deposit

  for (let i = 0; i < Math.min(3, testUsers.length); i++) {
    const user = testUsers[i];
    
    if (user.privateKey === "0x0000000000000000000000000000000000000000000000000000000000000000") {
      console.log(`⏭️  Skipping ${user.name} - private key not set`);
      continue;
    }

    const userWallet = new ethers.Wallet(user.privateKey, provider);
    const stakeToken = new ethers.Contract(
      contractAddresses.stakeToken,
      STAKE_TOKEN_ABI,
      userWallet
    );

    try {
      // Check balance first
      const balance = await stakeToken.balanceOf(userWallet.address) as Promise<bigint>;
      const balanceNum = await balance;
      console.log(`${user.name} balance: ${ethers.formatEther(balanceNum)} tokens`);
      
      if (balanceNum < depositAmount) {
        console.log(`⚠️  ${user.name} has insufficient balance. Need ${ethers.formatEther(depositAmount)}, have ${ethers.formatEther(balanceNum)}`);
        console.log(`   Run: npm run fund-users\n`);
        continue;
      }

      // Check current approval
      const currentAllowance = await stakeToken.allowance(userWallet.address, testMarket.marketAddress) as Promise<bigint>;
      const allowanceNum = await currentAllowance;
      
      if (allowanceNum < depositAmount) {
        console.log(`${user.name} approving tokens...`);
        const approveTx = await stakeToken.approve(testMarket.marketAddress, depositAmount);
        await approveTx.wait();
        console.log(`   ✅ Approved`);
      } else {
        console.log(`${user.name} already has sufficient approval`);
      }

      // Deposit (alternate between outcome 1 and 2)
      const outcome = (i % 2) + 1;
      console.log(`${user.name} depositing ${ethers.formatEther(depositAmount)} tokens on outcome ${outcome}...`);
      const marketWithSigner = market.connect(userWallet) as ethers.Contract;
      const depositTx = await (marketWithSigner.deposit as any)(outcome, depositAmount);
      await depositTx.wait();
      console.log(`✅ ${user.name} deposited successfully\n`);
    } catch (error: any) {
      console.error(`❌ Error with ${user.name}:`);
      if (error.reason) {
        console.error(`   Reason: ${error.reason}`);
      }
      if (error.data) {
        console.error(`   Error data: ${error.data}`);
      }
      console.log();
    }
  }

  // Step 3: Check pools
  const pools = await (market.pools() as Promise<[bigint, bigint] & { A: bigint; B: bigint }>);
  console.log("📊 Pool Status:");
  console.log(`   Outcome 1 (A): ${ethers.formatEther(pools.A)} tokens`);
  console.log(`   Outcome 2 (B): ${ethers.formatEther(pools.B)} tokens\n`);

  console.log("✅ Test flow complete!");
  console.log("\nNext steps:");
  console.log("1. Wait for lockTime, then call market.close()");
  console.log("2. Run oracle to post resolution");
  console.log("3. Wait for resolveTime, then call market.settle()");
  console.log("4. Winners call market.redeem()");
}

testMarketFlow().catch(console.error);

