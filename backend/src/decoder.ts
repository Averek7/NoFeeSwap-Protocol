import { ethers } from "ethers";
import { ACTIONS } from "./actions";
import type { DecodedSwap } from "./types";

const unlockInterface = new ethers.Interface([
  "function unlock(address unlockTarget, bytes data) payable returns (bytes result)"
]);

function u8(bytes: Uint8Array, offset: number): number {
  return bytes[offset] ?? 0;
}

function u16(bytes: Uint8Array, offset: number): number {
  return (u8(bytes, offset) << 8) | u8(bytes, offset + 1);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (
    (u8(bytes, offset) * 2 ** 24) +
    (u8(bytes, offset + 1) << 16) +
    (u8(bytes, offset + 2) << 8) +
    u8(bytes, offset + 3)
  );
}

function i256(bytes: Uint8Array, offset: number): bigint {
  return ethers.fromTwos(ethers.hexlify(bytes.slice(offset, offset + 32)), 256);
}

function u256(bytes: Uint8Array, offset: number): bigint {
  return ethers.toBigInt(ethers.hexlify(bytes.slice(offset, offset + 32)));
}

function u64(bytes: Uint8Array, offset: number): bigint {
  return ethers.toBigInt(ethers.hexlify(bytes.slice(offset, offset + 8)));
}

export function tryDecodeFrontendSwap(tx: ethers.TransactionResponse, expectedTarget: string): DecodedSwap | null {
  if (!tx.to || tx.to.toLowerCase() !== expectedTarget.toLowerCase() || !tx.data) {
    return null;
  }

  let parsed: ethers.Result;
  try {
    parsed = unlockInterface.decodeFunctionData("unlock", tx.data);
  } catch {
    return null;
  }

  const unlockTarget = String(parsed[0]);
  if (!unlockTarget) return null;
  const packedData = ethers.getBytes(parsed[1]);
  if (packedData.length < 5) return null;

  const deadline = u32(packedData, 0);
  const slots = new Map<number, bigint>();
  let offset = 4;

  while (offset < packedData.length) {
    const action = u8(packedData, offset);
    if (action === ACTIONS.PUSH32) {
      const value = i256(packedData, offset + 1);
      const slot = u8(packedData, offset + 33);
      slots.set(slot, value);
      offset += 34;
      continue;
    }

    if (action === ACTIONS.SWAP) {
      const poolId = u256(packedData, offset + 1);
      const amountSpecifiedSlot = u8(packedData, offset + 33);
      const limitOffsetted = u64(packedData, offset + 34);
      const zeroForOne = u8(packedData, offset + 42);
      const hookDataBytes = u16(packedData, offset + 47);
      const amountSpecified = slots.get(amountSpecifiedSlot);
      if (amountSpecified == null) return null;
      return {
        deadline,
        amountSpecified,
        limitOffsetted,
        zeroForOne,
        poolId,
        from: tx.from,
        hash: tx.hash,
        nonce: tx.nonce,
        gasPriceGwei: tx.gasPrice ? ethers.formatUnits(tx.gasPrice, "gwei") : undefined
      };
      // unreachable:
      offset += 49 + hookDataBytes;
    }

    offset += actionLength(packedData, offset, action);
  }

  return null;
}

function actionLength(bytes: Uint8Array, offset: number, action: number): number {
  switch (action) {
    case ACTIONS.NEG:
      return 3;
    case ACTIONS.LT:
      return 4;
    case ACTIONS.ISZERO:
      return 3;
    case ACTIONS.JUMPDEST:
      return 1;
    case ACTIONS.JUMP:
      return 4;
    case ACTIONS.TRANSFER_FROM_PAYER_ERC20:
      return 44;
    case ACTIONS.TAKE_TOKEN:
      return 43;
    case ACTIONS.SYNC_TOKEN:
      return 21;
    case ACTIONS.SETTLE:
      return 4;
    case ACTIONS.MODIFY_SINGLE_BALANCE:
      return 35;
    case ACTIONS.MODIFY_POSITION: {
      const hookLen = u16(bytes, offset + 29);
      return 31 + hookLen;
    }
    case ACTIONS.REVERT:
      return 1;
    default:
      return 1;
  }
}
