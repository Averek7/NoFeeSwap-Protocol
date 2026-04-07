export type DeploymentConfig = {
  rpcUrl: string;
  chainId: number;
  deployer: {
    root: string;
    owner: string;
    other: string;
  };
  contracts: {
    nofeeswap: string;
    nofeeswapDelegatee: string;
    operator: string;
    access: string;
    hook: string;
    deployerHelper: string;
  };
  mockTokens: {
    token0: string;
    token1: string;
    ownerBalanceToken0: string;
    ownerBalanceToken1: string;
  };
  samplePool: {
    owner: string;
    unsaltedPoolId: string;
    poolId: string;
    token0Tag: string;
    token1Tag: string;
    poolGrowthPortion: string;
    kernelCompact: string[];
    curve: string[];
  };
};

export type DecodedSwap = {
  deadline: number;
  amountSpecified: bigint;
  limitOffsetted: bigint;
  zeroForOne: number;
  poolId: bigint;
  from: string;
  hash: string;
  nonce: number;
  gasPriceGwei?: string;
};

export type SwapAnalysis = {
  currentPrice: number;
  limitPrice: number;
  tradeSize: number;
  slippageBps: number;
  estimatedImpactBps: number;
  vulnerable: boolean;
  riskRatio: number;
  direction: string;
  sharesTotal: bigint;
  frontrunSize: number;
  backrunSize: number;
  estimatedGrossPnlTokenOut: number;
  estimatedNetPnlTokenOut: number;
  profitable: boolean;
  recommendation: string;
};
