import { ethers } from "ethers";

export const X15 = 2n ** 15n;
export const X59 = 2n ** 59n;
export const X63 = 2n ** 63n;
export const LOG_PRICE_TICK_X59 = 57643193118714n;

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
const MODIFY_SINGLE_BALANCE = 50;
const SWAP = 52;
const MODIFY_POSITION = 53;
const REVERT = 59;

export function sortTokenPair(addressA, addressB) {
  return ethers.getBigInt(addressA) < ethers.getBigInt(addressB)
    ? [addressA, addressB]
    : [addressB, addressA];
}

export function encodeKernelCompact(kernel) {
  let bitLength = 0n;
  let packed = 0n;

  for (const [horizontal, vertical] of kernel.slice(1)) {
    packed <<= 16n;
    packed += BigInt(vertical);
    packed <<= 64n;
    packed += BigInt(horizontal);
    bitLength += 80n;
  }

  if (bitLength % 256n !== 0n) {
    const padding = 256n - (bitLength % 256n);
    packed <<= padding;
    bitLength += padding;
  }

  const words = [];
  let remaining = bitLength / 256n;
  while (remaining > 0n) {
    words.unshift(packed & ((1n << 256n) - 1n));
    packed >>= 256n;
    remaining -= 1n;
  }

  return words;
}

export function encodeCurve(curve) {
  const result = new Array(Math.floor((curve.length + 3) / 4)).fill(0n);
  let shift = 192n;
  let index = 0;

  for (const point of curve) {
    result[Math.floor(index / 4)] += BigInt(point) << shift;
    shift = (shift - 64n + 256n) % 256n;
    index += 1;
  }

  return result;
}

export function twosComplementInt8(value) {
  const intValue = Number(value);
  return intValue >= 0 ? intValue : 256 + intValue;
}

export function computePoolId(sender, unsaltedPoolId) {
  const packed = ethers.solidityPacked(["address", "uint256"], [sender, unsaltedPoolId]);
  const hash = ethers.getBigInt(ethers.keccak256(packed));
  return (BigInt(unsaltedPoolId) + ((hash << 188n) & ((1n << 256n) - 1n))) & ((1n << 256n) - 1n);
}

export function computeUnsaltedPoolId(sequenceId, logOffset = 0, hookAddress = ethers.ZeroAddress) {
  const hookPart = ethers.getBigInt(hookAddress) & ((1n << 160n) - 1n);
  return (
    (BigInt(sequenceId) << 188n) +
    (BigInt(twosComplementInt8(logOffset)) << 180n) +
    hookPart
  );
}

export function priceToLogPriceX59(price) {
  return BigInt(Math.floor(Number(X59) * Math.log(Number(price))));
}

export function priceToOffsetted(price, logOffset = 0) {
  return priceToLogPriceX59(price) - BigInt(logOffset) * X59 + X63;
}

export function offsettedToPrice(offsetted, logOffset = 0) {
  const logPrice = Number(BigInt(offsetted) - X63 + BigInt(logOffset) * X59);
  return Math.exp(logPrice / Number(X59));
}

export function buildCurveFromPrice(initialPrice, spacingX59, logOffset = 0) {
  const current = priceToOffsetted(initialPrice, logOffset);
  const spacing = BigInt(spacingX59);
  const lower = current - ((current - X63) % spacing);
  const upper = lower + spacing;
  return [lower, upper, current];
}

export function deadlineFromNow(seconds = 1800) {
  return Math.floor(Date.now() / 1000) + seconds;
}

export function rangePricesToQ(priceMin, priceMax) {
  return {
    qMin: priceToLogPriceX59(priceMin),
    qMax: priceToLogPriceX59(priceMax)
  };
}

export function qToDisplayPrice(qValue) {
  return Math.exp(Number(BigInt(qValue)) / Number(X59));
}

export function computeTagShares(poolId, qMin, qMax) {
  return ethers.getBigInt(
    ethers.solidityPackedKeccak256(["uint256", "int256", "int256"], [poolId, qMin, qMax])
  );
}

function pack(types, values) {
  return ethers.solidityPacked(types, values);
}

function byteLength(sequence) {
  return sequence.reduce((total, item) => total + ethers.dataLength(item), 0);
}

export function buildMintSequence({ nofeeswap, token0, token1, poolId, qMin, qMax, shares, deadline }) {
  const sharesSlot = 1;
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
  const sharesSuccessSlot = 15;
  const lower = BigInt(qMin) + X63;
  const upper = BigInt(qMax) + X63;
  const tagShares = computeTagShares(poolId, qMin, qMax);

  const sequence = [
    pack(["uint8", "int256", "uint8"], [PUSH32, BigInt(shares), sharesSlot]),
    pack(["uint8", "uint256", "uint64", "uint64", "uint8", "uint8", "uint8", "uint8", "uint16", "bytes"], [MODIFY_POSITION, BigInt(poolId), lower, upper, sharesSlot, successSlot, amount0Slot, amount1Slot, 0, "0x"]),
    pack(["uint8", "address"], [SYNC_TOKEN, token0]),
    pack(["uint8", "address", "uint8", "address", "uint8", "uint8"], [TRANSFER_FROM_PAYER_ERC20, token0, amount0Slot, nofeeswap, successSlotTransfer0, 0]),
    pack(["uint8", "uint8", "uint8", "uint8"], [SETTLE, valueSlotSettle0, successSlotSettle0, resultSlotSettle0]),
    pack(["uint8", "address"], [SYNC_TOKEN, token1]),
    pack(["uint8", "address", "uint8", "address", "uint8", "uint8"], [TRANSFER_FROM_PAYER_ERC20, token1, amount1Slot, nofeeswap, successSlotTransfer1, 0]),
    pack(["uint8", "uint8", "uint8", "uint8"], [SETTLE, valueSlotSettle1, successSlotSettle1, resultSlotSettle1]),
    pack(["uint8", "uint256", "uint8", "uint8"], [MODIFY_SINGLE_BALANCE, tagShares, sharesSlot, sharesSuccessSlot])
  ];

  return pack(["uint32", ...new Array(sequence.length).fill("bytes")], [deadline, ...sequence]);
}

export function buildBurnSequence({ token0, token1, recipient, poolId, qMin, qMax, shares, deadline }) {
  const sharesSlot = 1;
  const successSlot = 2;
  const amount0Slot = 3;
  const amount1Slot = 4;
  const successSlotSettle0 = 10;
  const successSlotSettle1 = 13;
  const sharesSuccessSlot = 15;
  const lower = BigInt(qMin) + X63;
  const upper = BigInt(qMax) + X63;
  const tagShares = computeTagShares(poolId, qMin, qMax);

  const sequence = [
    pack(["uint8", "int256", "uint8"], [PUSH32, -BigInt(shares), sharesSlot]),
    pack(["uint8", "uint256", "uint64", "uint64", "uint8", "uint8", "uint8", "uint8", "uint16", "bytes"], [MODIFY_POSITION, BigInt(poolId), lower, upper, sharesSlot, successSlot, amount0Slot, amount1Slot, 0, "0x"]),
    pack(["uint8", "uint8", "uint8"], [NEG, amount0Slot, amount0Slot]),
    pack(["uint8", "uint8", "uint8"], [NEG, amount1Slot, amount1Slot]),
    pack(["uint8", "address", "address", "uint8", "uint8"], [TAKE_TOKEN, token0, recipient, amount0Slot, successSlotSettle0]),
    pack(["uint8", "address", "address", "uint8", "uint8"], [TAKE_TOKEN, token1, recipient, amount1Slot, successSlotSettle1]),
    pack(["uint8", "uint256", "uint8", "uint8"], [MODIFY_SINGLE_BALANCE, tagShares, sharesSlot, sharesSuccessSlot])
  ];

  return pack(["uint32", ...new Array(sequence.length).fill("bytes")], [deadline, ...sequence]);
}

export function buildSwapSequence({ nofeeswap, token0, token1, recipient, poolId, amountSpecified, limitPrice, zeroForOne, deadline }) {
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
  sequence[0] = pack(["uint8", "int256", "uint8"], [PUSH32, BigInt(amountSpecified), amountSpecifiedSlot]);
  sequence[1] = pack(["uint8", "uint256", "uint8", "uint64", "uint8", "uint8", "uint8", "uint8", "uint8", "uint16", "bytes"], [SWAP, BigInt(poolId), amountSpecifiedSlot, limitOffsetted, zeroForOne, zeroSlot, successSlot, amount0Slot, amount1Slot, 0, "0x"]);
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
  sequence[13] = pack(["uint8", "address", "uint8", "address", "uint8", "uint8"], [TRANSFER_FROM_PAYER_ERC20, token0, amount0Slot, nofeeswap, successSlotTransfer0, 0]);
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
  sequence[24] = pack(["uint8", "address", "uint8", "address", "uint8", "uint8"], [TRANSFER_FROM_PAYER_ERC20, token1, amount1Slot, nofeeswap, successSlotTransfer1, 0]);
  sequence[25] = pack(["uint8", "uint8", "uint8", "uint8"], [SETTLE, valueSlotSettle1, successSlotSettle1, resultSlotSettle1]);
  sequence[26] = pack(["uint8"], [JUMPDEST]);
  sequence[22] = pack(["uint8", "uint16", "uint8"], [JUMP, byteLength(sequence.slice(0, 26)), logicSlot]);

  return pack(["uint32", ...new Array(sequence.length).fill("bytes")], [deadline, ...sequence]);
}

export function estimateSwapFromSpot({ currentPrice, amount, zeroForOne, slippage }) {
  const amountNumber = Number(amount);
  const spotOut = zeroForOne ? amountNumber / currentPrice : amountNumber * currentPrice;
  const impact = Math.min(Math.max(slippage * 0.4, 0.05), Number(slippage));
  return {
    estimatedOutput: spotOut * (1 - impact / 100),
    priceImpact: impact
  };
}

export function makePoolSummary(pool) {
  const current = pool.curve?.[2] ?? X63;
  const currentPrice = offsettedToPrice(current);
  return {
    ...pool,
    currentPrice
  };
}
