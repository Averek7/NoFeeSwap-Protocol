module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 500
      },
      evmVersion: "cancun"
    }
  },
  networks: {
    hardhat: {
      hardfork: "cancun",
      chainId: 31337,
      initialBaseFeePerGas: 0,
      allowUnlimitedContractSize: true,
      accounts: {
        mnemonic: "test test test test test test test test test test test junk",
        count: 10
      }
    }
  }
};
