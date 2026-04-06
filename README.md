# NoFeeSwap Local Dev Environment

This workspace starts a local Hardhat chain, compiles the NoFeeSwap `core` and `operator` repos with the same Solidity settings used by the repos, and deploys:

- `DeployerHelper`
- `Nofeeswap`
- `NofeeswapDelegatee`
- `Operator`
- `Access`
- `MockHook`
- Two mock ERC-20 tokens minted to the test owner wallet
- One sample initialized pool for the mock token pair

## Commands

```powershell
npm install
npm run start
npm run deploy
```

Deployment output is written to `deployments/local.json`.

## Frontend

```powershell
cd frontend
npm install
npm run dev
```

The React app expects the local Hardhat node at `http://127.0.0.1:8545` and uses the addresses from `deployments/local.json`.

## Safe Mempool Monitor

This backend watches pending swap transactions from the frontend, decodes the NoFeeSwap operator payload, and prints a sandwich-risk simulation without submitting any on-chain transactions.

```powershell
npm run automine:off
npm run bot
```

Submit a swap from the frontend while automine is off so the transaction remains visible in the pending pool. Re-enable instant mining afterward:

```powershell
npm run automine:on
```

## Local Accounts

The Hardhat node uses the standard test mnemonic:

```text
test test test test test test test test test test test junk
```

The deploy script uses:

- account `0` as the admin/deployer
- account `1` as the sample owner wallet that receives both mock ERC-20 supplies

## Stop The Node

```powershell
npm run stop
```
