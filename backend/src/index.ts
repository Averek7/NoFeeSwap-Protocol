import { ethers } from "ethers";
import { analyzeSwap } from "./analyzer";
import { DEPLOYMENT, NOFEESWAP_ABI, WS_RPC_URL } from "./config";
import { tryDecodeFrontendSwap } from "./decoder";

async function main() {
  const wsProvider = new ethers.WebSocketProvider(WS_RPC_URL);
  const httpProvider = new ethers.JsonRpcProvider(DEPLOYMENT.rpcUrl);
  const nofeeswap = new ethers.Contract(DEPLOYMENT.contracts.nofeeswap, NOFEESWAP_ABI, httpProvider);

  console.log("Safe mempool monitor started.");
  console.log(`Watching pending transactions for ${DEPLOYMENT.contracts.nofeeswap}`);
  console.log("This backend only decodes and simulates sandwich-risk exposure; it does not submit transactions.");

  wsProvider.on("pending", async (hash: string) => {
    try {
      const tx = await httpProvider.getTransaction(hash);
      if (!tx) return;

      const decoded = tryDecodeFrontendSwap(tx, DEPLOYMENT.contracts.nofeeswap);
      if (!decoded) return;

      const report = await analyzeSwap(httpProvider, decoded);
      console.log("\n=== Pending Frontend Swap Detected ===");
      console.log(`hash:       ${decoded.hash}`);
      console.log(`from:       ${decoded.from}`);
      console.log(`poolId:     ${decoded.poolId.toString()}`);
      console.log(`direction:  ${report.direction}`);
      console.log(`size:       ${report.tradeSize.toFixed(6)}`);
      console.log(`slippage:   ${report.slippageBps.toFixed(2)} bps`);
      console.log(`impact est: ${report.estimatedImpactBps.toFixed(2)} bps`);
      console.log(`spot price: ${report.currentPrice.toFixed(6)}`);
      console.log(`limit:      ${report.limitPrice.toFixed(6)}`);
      console.log(`risk:       ${report.vulnerable ? "sandwich-exposed" : "lower exposure"}`);
      console.log(`advice:     ${report.recommendation}`);
      console.log(`gas gwei:   ${decoded.gasPriceGwei ?? "n/a"}`);
      console.log(`deadline:   ${decoded.deadline}`);

      try {
        await nofeeswap.unlock.staticCall(DEPLOYMENT.contracts.operator, tx.data);
      } catch {
        // We only care about pending detection and simulation here.
      }
    } catch (error) {
      console.error("monitor error:", error);
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
