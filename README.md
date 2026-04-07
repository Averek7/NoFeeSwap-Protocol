# NoFeeSwap Local Dev Environment

Local workspace for running NoFeeSwap end-to-end on Hardhat:
- Deploy protocol + operator + mock tokens
- Interact through React UI (init pool, liquidity, swap)
- Monitor mempool and simulate sandwich risk from backend

## What Gets Deployed

- `DeployerHelper`
- `Nofeeswap`
- `NofeeswapDelegatee`
- `Operator`
- `Access`
- `MockHook`
- Two mock ERC-20 tokens (minted to owner test wallet)
- One sample initialized pool

Deployment output is written to `deployments/local.json`.

## Quick Start

```bash
npm install
npm run start
npm run deploy
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Backend monitor:

```bash
# from repo root
npm run automine:off
npm run bot
```

After capturing pending tx analysis:

```bash
npm run automine:on
```

## Technical Architecture

### Components

- Frontend (`frontend/src`): React + ethers v6 UI for wallet connection, pool init, liquidity, and swaps.
- Backend (`backend/src`): pending tx monitor + calldata decoder + sandwich-risk analyzer + optional local execution mode.
- Deploy pipeline (`scripts/deploy.js`): compiles `core` and `operator`, deploys protocol stack, writes `deployments/local.json`.

### Data / Control Flow

1. User signs tx in frontend via MetaMask.
2. Frontend sends `nofeeswap.unlock(operator, sequence)` calldata.
3. Backend listens to mempool `pending` hashes over WebSocket.
4. Backend fetches tx body over HTTP RPC, decodes operator action stream, extracts swap parameters.
5. Analyzer enriches with on-chain pool dynamic state from `Access`.
6. Bot prints risk + simulation metrics; optional execution mode may submit local attacker txs.

### Key Files

- Frontend core UI: `frontend/src/App.jsx`
- Swap/liquidity sequence builder: `frontend/src/lib/nofeeswap.js`
- ABI definitions: `frontend/src/lib/abi.js`
- Network/deployment config: `frontend/src/lib/config.js`
- Mempool monitor entry: `backend/src/index.ts`
- Decoder: `backend/src/decoder.ts`
- Analyzer: `backend/src/analyzer.ts`
- Optional local executor: `backend/src/executor.ts`
- Type contracts: `backend/src/types.ts`

## Decoding and Simulation Details

### Pending Swap Detection

- Filters txs by `to == deployments.local.contracts.nofeeswap`.
- Decodes `unlock(address,bytes)` payload.
- Parses operator bytecode-like action stream and captures:
  - `poolId`
  - `amountSpecified`
  - `limitOffsetted`
  - `zeroForOne`
  - `deadline`

### Risk / PnL Model (Current Implementation)

- Computes spot/limit price from X59/X63 fixed-point offset representation.
- Estimates:
  - slippage window (bps)
  - impact proxy (bps)
  - vulnerability posture
  - front/back run sizes
  - gross/net tokenOut PnL estimate
- This is a heuristic local model for visibility and test iteration, not a formal execution optimizer.

## Execution Mode (Local Guarded)

Default behavior is simulation-only.

Execution mode (`EXECUTE_LOCAL_ATTACK=true`) is intentionally guarded:

- localhost RPC only (`127.0.0.1` / `localhost`)
- chain check against `deployments/local.json`
- sample pool-only handling in current implementation
- profitability threshold gating before submitting txs
- separate attacker signer index (`ATTACKER_INDEX`, default `2`)
- optional local mining after submit (`MINE_AFTER_ATTACK`, default `true`)

When enabled, the bot attempts:
- frontrun tx submission
- backrun tx submission in opposite swap direction
- mined-order verification (`front < victim < back`) when present in the same block
- attacker balance delta reporting (`Δtoken0`, `Δtoken1`)

This mode is for controlled local demos and ordering experiments only.

## Local Network & Accounts

- RPC: `http://127.0.0.1:8545`
- Chain ID: `1337`
- Mnemonic:

```text
test test test test test test test test test test test junk
```

Default roles:
- account `0`: deployer/admin
- account `1`: owner wallet with mock token balances

## Mempool Bot Modes

Simulation-only (default):

```bash
npm run bot
```

Optional local execution mode (localhost-restricted):

```bash
EXECUTE_LOCAL_ATTACK=true ATTACKER_INDEX=2 ATTACK_FRACTION_BPS=3000 npm run bot
```

Optional execution tuning:

```bash
EXECUTE_LOCAL_ATTACK=true \
ATTACKER_INDEX=2 \
ATTACK_FRACTION_BPS=3000 \
MIN_NET_PNL_TOKENOUT=0 \
MINE_AFTER_ATTACK=true \
npm run bot
```

Notes:
- Keep this local only.
- Execution mode is guarded and not meant for public networks.

## Useful Commands

```bash
npm run start
npm run stop
npm run deploy
npm run automine:off
npm run automine:on
npm run bot
```

Type-check backend and deployment typings:

```bash
npx tsc --noEmit
```

## Troubleshooting

- `Nonce too high`: clear MetaMask activity, send one tx at a time when automine is off.
- `Invalid chainId`: ensure MetaMask localhost network is chain `1337`.
- swap disabled/revert: mint liquidity first (`Pool Shares > 0`).
- backend `ECONNREFUSED`: start node first (`npm run start`).
- swap estimate reverts with custom errors: verify token ordering and slippage direction assumptions for selected pool.
- pending tx not seen by bot: confirm `automine:off`, then submit a new swap tx after bot starts.

## Recent Edits (Transparency)

The following high-impact edits were introduced recently to stabilize local execution and improve clarity:

- Frontend:
  - locked local network handling to chain `1337`
  - fixed swap direction/limit logic causing custom error reverts
  - fixed decimal swap inputs (`step="any"`)
  - improved post-tx refresh behavior when `Access._readCurve` reverts
  - added no-liquidity swap guard (`Mint Liquidity First`)
- Backend:
  - expanded mempool output to structured simulation metrics
  - completed local guarded attack execution module (`backend/src/executor.ts`)
  - added opposite-direction backrun construction
  - added block-order verification and attacker balance delta reporting
  - added websocket transport error handlers and execution mode status logging
  - added stronger typings for analysis output
- Scripts:
  - deploy/start/stop hardening for local workflow consistency
  - added deterministic local redeploy path with `deployments/local.json` as single source of truth

### Explicitly Omitted in Recent Edits

- No public/mainnet MEV execution support
- No production-grade profitability solver or full market-impact engine
- No Solidity attack helper contract (EOA ordering approach only)

## Delivery Status (Compact)

- Task 1 (local deploy environment): `COMPLETE`
- Task 2 (frontend flows): `COMPLETE`
- Task 3a/3b (mempool watch + decode): `COMPLETE`
- Task 3c (sandwich): `COMPLETE` for local guarded mode
  - off-chain simulation: `COMPLETE`
  - local guarded execution mode: `COMPLETE`
  - public/mainnet execution support: `OMITTED` (out of scope by design)
