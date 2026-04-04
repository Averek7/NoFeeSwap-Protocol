export const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

export const NOFEESWAP_ABI = [
  "function dispatch(bytes input) returns (int256 output0, int256 output1)",
  "function unlock(address unlockTarget, bytes data) payable returns (bytes result)",
  "function setOperator(address spender, bool approved) returns (bool)",
  "function isOperator(address owner, address spender) view returns (bool)",
  "function balanceOf(address owner, uint256 tag) view returns (uint256)"
];

export const DELEGATEE_ABI = [
  "function initialize(uint256 unsaltedPoolId, uint256 tag0, uint256 tag1, uint256 poolGrowthPortion, uint256[] kernelCompactArray, uint256[] curveArray, bytes hookData)"
];

export const ACCESS_ABI = [
  "function _readDynamicParams(address nofeeswap, uint256 poolId) view returns (uint16 extension, uint256 staticParamsStoragePointer, uint64 logPriceCurrent, uint128 sharesTotal, uint128 growth, uint216 integral0, uint216 integral1)",
  "function _readCurve(address nofeeswap, uint256 poolId, uint64 logPriceCurrent) view returns (uint256[] memory)"
];
