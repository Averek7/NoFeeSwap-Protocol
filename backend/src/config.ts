import deployment from "../../deployments/local.json";
import type { DeploymentConfig } from "./types";

export const DEPLOYMENT = deployment as DeploymentConfig;
export const WS_RPC_URL = DEPLOYMENT.rpcUrl.replace("http://", "ws://").replace("https://", "wss://");

export const NOFEESWAP_ABI = [
  "function unlock(address unlockTarget, bytes data) payable returns (bytes result)"
] as const;

export const ACCESS_ABI = [
  "function _readDynamicParams(address nofeeswap, uint256 poolId) view returns (uint16 extension, uint256 staticParamsStoragePointer, uint64 logPriceCurrent, uint128 sharesTotal, uint128 growth, uint216 integral0, uint216 integral1)"
] as const;
