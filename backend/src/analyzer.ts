import { ethers } from "ethers";
import { ACCESS_ABI, DEPLOYMENT } from "./config";
import type { DecodedSwap, SwapAnalysis } from "./types";

const X59 = 2n ** 59n;
const X63 = 2n ** 63n;

export function offsettedToPrice(offsetted: bigint): number {
  const logPrice = Number(offsetted - X63);
  return Math.exp(logPrice / Number(X59));
}

export async function analyzeSwap(provider: ethers.Provider, decoded: DecodedSwap): Promise<SwapAnalysis> {
  const access = new ethers.Contract(DEPLOYMENT.contracts.access, ACCESS_ABI, provider);
  const dynamic = await access._readDynamicParams(DEPLOYMENT.contracts.nofeeswap, decoded.poolId);
  const currentOffsetted = BigInt(dynamic.logPriceCurrent);
  const currentPrice = offsettedToPrice(currentOffsetted);
  const limitPrice = offsettedToPrice(decoded.limitOffsetted);
  const tradeSize = Number(ethers.formatUnits(decoded.amountSpecified < 0n ? -decoded.amountSpecified : decoded.amountSpecified, 18));
  const slippageBps = Math.abs(((limitPrice - currentPrice) / currentPrice) * 10_000);
  const estimatedImpactBps = Math.min(2500, Math.max(8, tradeSize * 35));
  const riskRatio = slippageBps === 0 ? Infinity : estimatedImpactBps / slippageBps;
  const vulnerable = slippageBps > 30 && estimatedImpactBps > 10;
  const direction =
    decoded.zeroForOne === 0
      ? "token0 -> token1"
      : decoded.zeroForOne === 1
        ? "token1 -> token0"
        : "price-directed";

  // Local-only heuristic "sandwich simulation" for visibility in logs.
  // This does not submit transactions; it estimates ordering economics.
  const frontrunSize = tradeSize * 0.35;
  const backrunSize = frontrunSize;
  const victimSlip = slippageBps / 10_000;
  const expectedMove = estimatedImpactBps / 10_000;
  const grossPnlPct = Math.max(0, Math.min(victimSlip, expectedMove) * 0.65);
  const estimatedGrossPnlTokenOut = frontrunSize * currentPrice * grossPnlPct;
  const gasCostTokenOut = (decoded.gasPriceGwei ? Number(decoded.gasPriceGwei) : 1) * 0.00006;
  const estimatedNetPnlTokenOut = estimatedGrossPnlTokenOut - gasCostTokenOut;
  const profitable = estimatedNetPnlTokenOut > 0;

  return {
    currentPrice,
    limitPrice,
    tradeSize,
    slippageBps,
    estimatedImpactBps,
    vulnerable,
    riskRatio,
    direction,
    sharesTotal: BigInt(dynamic.sharesTotal),
    frontrunSize,
    backrunSize,
    estimatedGrossPnlTokenOut,
    estimatedNetPnlTokenOut,
    profitable,
    recommendation: vulnerable
      ? "Tighten slippage, use delayed/private execution, or split order size."
      : "Current slippage window appears relatively tight for this trade size."
  };
}
