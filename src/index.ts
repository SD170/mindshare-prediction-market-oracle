/// <reference types="node" />
import { processMarkets } from "./oracle.ts";

async function main() {
  console.log("🚀 Starting Mindshare Oracle Pipeline...\n");

  try {
    await processMarkets();
  } catch (error) {
    console.error("❌ Oracle pipeline failed:", error);
    process.exit(1);
  }
}

main();

