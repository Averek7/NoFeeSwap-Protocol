import deployment from "../../../deployments/local.json";

export const LOCAL_CHAIN = {
  chainId: "0x7a69",
  chainName: "Hardhat Local 31337",
  rpcUrls: ["http://127.0.0.1:8545"],
  nativeCurrency: {
    name: "Ether",
    symbol: "ETH",
    decimals: 18
  }
};

export const DEPLOYMENT = {
  ...deployment,
  contracts: {
    nofeeswap: deployment.contracts.nofeeswap,
    delegatee: deployment.contracts.nofeeswapDelegatee,
    operator: deployment.contracts.operator,
    access: deployment.contracts.access
  },
  tokens: [
    {
      key: "token0",
      label: "ERC20_0",
      address: deployment.mockTokens.token0
    },
    {
      key: "token1",
      label: "ERC20_1",
      address: deployment.mockTokens.token1
    }
  ],
  samplePool: {
    name: "Sample Pool",
    ...deployment.samplePool,
    token0: deployment.mockTokens.token0,
    token1: deployment.mockTokens.token1
  }
};

export const POOL_PRESETS = [
  {
    label: "Tight 0.05%",
    spacingX59: 576604915547748n,
    verticalX15: 32768n
  },
  {
    label: "Balanced 0.3%",
    spacingX59: 3451983060287646n,
    verticalX15: 32768n
  },
  {
    label: "Wide 1.0%",
    spacingX59: 5793624167011548n,
    verticalX15: 32768n
  }
];
