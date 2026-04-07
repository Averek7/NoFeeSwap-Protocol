import { ethers } from "ethers";
import { analyzeSwap } from "./analyzer";
import { DEPLOYMENT, NOFEESWAP_ABI, WS_RPC_URL } from "./config";
import { tryDecodeFrontendSwap } from "./decoder";
import { getExecConfig, tryExecuteLocalSandwich } from "./executor";

async function main() {
  const wsProvider = new ethers.WebSocketProvider(WS_RPC_URL);
  const httpProvider = new ethers.JsonRpcProvider(DEPLOYMENT.rpcUrl);
  const nofeeswap = new ethers.Contract(DEPLOYMENT.contracts.nofeeswap, NOFEESWAP_ABI, httpProvider);
  const execConfig = getExecConfig();
  const seen = new Set<string>();

  console.log("Safe mempool monitor started.");
  console.log(`Watching pending transactions for ${DEPLOYMENT.contracts.nofeeswap}`);
  console.log("This backend only decodes and simulates sandwich-risk exposure; it does not submit transactions.");
  console.log(
    execConfig.enabled
      ? `Execution mode: ENABLED (attacker index ${execConfig.attackerIndex}, size ${execConfig.attackFractionBps} bps)`
      : "Execution mode: disabled (set EXECUTE_LOCAL_ATTACK=true for local-only tx broadcast)"
  );

  wsProvider.on("error", (error) => {
    console.error("ws error:", error);
  });
  const rawWs = (wsProvider as unknown as { websocket?: { on?: (event: string, cb: (...args: unknown[]) => void) => void } }).websocket;
  rawWs?.on?.("error", (error: unknown) => {
    console.error("ws transport error:", error);
  });
  rawWs?.on?.("close", (code: unknown) => {
    console.error("ws transport closed:", code);
  });

  wsProvider.on("pending", async (hash: string) => {
    try {
      if (seen.has(hash)) return;
      seen.add(hash);
      if (seen.size > 2000) {
        seen.clear();
      }

      const tx = await httpProvider.getTransaction(hash);
      if (!tx) return;

      const decoded = tryDecodeFrontendSwap(tx, DEPLOYMENT.contracts.nofeeswap);
      if (!decoded) return;

      const report = await analyzeSwap(httpProvider, decoded);
      console.log("\n=== Pending Frontend Swap Detected ===");
      console.log(`hash:            ${decoded.hash}`);
      console.log(`from:            ${decoded.from}`);
      console.log(`poolId:          ${decoded.poolId.toString()}`);
      console.log(`direction:       ${report.direction}`);
      console.log(`trade size:      ${report.tradeSize.toFixed(6)}`);
      console.log(`shares total:    ${report.sharesTotal.toString()}`);
      console.log(`slippage:        ${report.slippageBps.toFixed(2)} bps`);
      console.log(`impact est:      ${report.estimatedImpactBps.toFixed(2)} bps`);
      console.log(`spot price:      ${report.currentPrice.toFixed(6)}`);
      console.log(`limit price:     ${report.limitPrice.toFixed(6)}`);
      console.log(`risk posture:    ${report.vulnerable ? "sandwich-exposed" : "lower exposure"}`);
      console.log(`gas gwei:        ${decoded.gasPriceGwei ?? "n/a"}`);
      console.log(`deadline unix:   ${decoded.deadline}`);
      console.log("--- Sandwich Simulation (Local / Off-chain) ---");
      console.log(`front-run size:  ${report.frontrunSize.toFixed(6)}`);
      console.log(`back-run size:   ${report.backrunSize.toFixed(6)}`);
      console.log(`gross pnl est:   ${report.estimatedGrossPnlTokenOut.toFixed(8)} tokenOut`);
      console.log(`net pnl est:     ${report.estimatedNetPnlTokenOut.toFixed(8)} tokenOut`);
      console.log(`profitable est:  ${report.profitable ? "yes" : "no"}`);
      console.log(`advice:          ${report.recommendation}`);

      const exec = await tryExecuteLocalSandwich({
        provider: httpProvider,
        decoded,
        report,
        config: execConfig
      });
      if (exec.executed) {
        console.log("--- Execution (Local EOA) ---");
        console.log(`front-run hash:  ${exec.frontrunHash}`);
        console.log(`back-run hash:   ${exec.backrunHash}`);
      } else {
        console.log(`execution:       skipped (${exec.skippedReason})`);
      }

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
