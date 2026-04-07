import { useEffect, useMemo, useState, useCallback } from "react";
import { ethers } from "ethers";
import { ACCESS_ABI, DELEGATEE_ABI, ERC20_ABI, NOFEESWAP_ABI } from "./lib/abi";
import {
  DEPLOYMENT,
  LOCAL_CHAIN,
  POOL_PRESETS,
  PREFERRED_LOCAL_CHAIN_ID,
  SUPPORTED_LOCAL_CHAIN_IDS,
} from "./lib/config";
import ConnectionPanel from "./components/ConnectionPanel";
import {
  buildBurnSequence,
  buildCurveFromPrice,
  buildMintSequence,
  buildSwapSequence,
  computePoolId,
  computeUnsaltedPoolId,
  deadlineFromNow,
  encodeCurve,
  encodeKernelCompact,
  estimateSwapFromSpot,
  makePoolSummary,
  offsettedToPrice,
  qToDisplayPrice,
  rangePricesToQ,
  sortTokenPair,
} from "./lib/nofeeswap";

/* constants */
const STORAGE_KEY = "nofeeswap-local-pools";
const WALLET_CONNECTED_KEY = "walletConnected";

/* helpers */
function compact(value) {
  const s = String(value);
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function formatUnits(value, decimals) {
  if (value == null) return "—";
  return Number(ethers.formatUnits(value, decimals ?? 18)).toLocaleString(
    undefined,
    {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    },
  );
}

function floorDiv(a, b) {
  let q = a / b;
  if (a < 0n !== b < 0n && a % b !== 0n) q -= 1n;
  return q;
}

function ceilDiv(a, b) {
  let q = a / b;
  if (a < 0n === b < 0n && a % b !== 0n) q += 1n;
  return q;
}

function snapRangeToSpacing(qMin, qMax, spacing) {
  if (!spacing || spacing <= 0n) return { qMin, qMax };
  const snappedMin = floorDiv(BigInt(qMin), spacing) * spacing;
  let snappedMax = ceilDiv(BigInt(qMax), spacing) * spacing;
  if (snappedMax <= snappedMin) snappedMax = snappedMin + spacing;
  return { qMin: snappedMin, qMax: snappedMax };
}

export default function App() {
  /* wallet */
  const [browserProvider, setBrowserProvider] = useState(null);
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [address, setAddress] = useState("");
  const [walletStatus, setWalletStatus] = useState("idle"); // idle | connecting | connected | error
  const [networkReady, setNetworkReady] = useState(false);
  const [networkLabel, setNetworkLabel] = useState("Wallet not connected");
  const [networkMessage, setNetworkMessage] = useState(
    "Connect MetaMask to use the local NoFeeSwap deployment.",
  );
  const [activeChainId, setActiveChainId] = useState(null);

  /* chain state */
  const [tokenMeta, setTokenMeta] = useState({});
  const [walletBalances, setWalletBalances] = useState({});
  const [operatorEnabled, setOperatorEnabled] = useState(false);
  const [poolState, setPoolState] = useState(null);

  /* pools */
  const [selectedPoolId, setSelectedPoolId] = useState(
    DEPLOYMENT.samplePool.poolId,
  );
  const [customPools, setCustomPools] = useState([]);

  /* forms */
  const [initForm, setInitForm] = useState({
    sequenceId: "2",
    price: "1.10",
    growthPortion: DEPLOYMENT.samplePool.poolGrowthPortion,
    preset: 2,
  });
  const [kernelPoint, setKernelPoint] = useState({
    x: Number(POOL_PRESETS[2].spacingX59) / 1e15,
    y: Number(POOL_PRESETS[2].verticalX15) / 32768,
  });
  const [liquidityForm, setLiquidityForm] = useState({
    mode: "mint",
    lowerPrice: "0.90",
    upperPrice: "1.20",
    shares: "1000000000000000000",
  });
  const [swapForm, setSwapForm] = useState({
    tokenIn: DEPLOYMENT.tokens[0].address,
    amountIn: "1",
    slippage: "1",
  });

  /* ui state */
  const [txState, setTxState] = useState(null); // { type, label, message, hash }
  const [positionState, setPositionState] = useState(null);
  const [activeTab, setActiveTab] = useState("pool"); // pool | liquidity | swap | init
  const [hasMetaMask, setHasMetaMask] = useState(false);

  const syncNetworkState = useCallback((chainId) => {
    setActiveChainId(chainId ?? null);

    if (!chainId) {
      setNetworkReady(false);
      setNetworkLabel("Network unknown");
      setNetworkMessage("MetaMask did not return a chain ID.");
      return false;
    }

    if (SUPPORTED_LOCAL_CHAIN_IDS.includes(chainId)) {
      setNetworkReady(true);
      setNetworkLabel("Hardhat 1337");
      setNetworkMessage("Connected to local Hardhat chain.");
      return true;
    }

    setNetworkReady(false);
    setNetworkLabel(`Wrong network (${chainId})`);
    setNetworkMessage(
      "Switch MetaMask to the local node at http://127.0.0.1:8545.",
    );
    return false;
  }, []);

  const syncInjectedWallet = useCallback(
    async (injectedProvider) => {
      if (!window.ethereum) return;

      const [accounts, chainId] = await Promise.all([
        window.ethereum.request({ method: "eth_accounts" }),
        window.ethereum.request({ method: "eth_chainId" }),
      ]);

      syncNetworkState(chainId);

      if (!accounts.length) {
        setSigner(null);
        setAddress("");
        setWalletStatus("idle");
        return;
      }

      const nextSigner = await injectedProvider.getSigner();
      setSigner(nextSigner);
      setAddress(accounts[0]);
      setWalletStatus("connected");
    },
    [syncNetworkState],
  );

  /* ── derived ── */
  const pools = useMemo(
    () => [DEPLOYMENT.samplePool, ...customPools].map(makePoolSummary),
    [customPools],
  );
  const selectedPool = useMemo(
    () => pools.find((p) => p.poolId === selectedPoolId) ?? pools[0],
    [pools, selectedPoolId],
  );
  const currentPrice = poolState?.currentPrice ?? selectedPool?.currentPrice;
  const hasPoolLiquidity = (poolState?.sharesTotal ?? 0n) > 0n;

  const swapPreview = useMemo(() => {
    if (!selectedPool) return null;
    const amount = Number(swapForm.amountIn || 0);
    if (!amount) return null;
    const token0In =
      swapForm.tokenIn.toLowerCase() === selectedPool.token0.toLowerCase();
    return estimateSwapFromSpot({
      currentPrice: poolState?.currentPrice ?? selectedPool.currentPrice,
      amount,
      token0In,
      slippage: Number(swapForm.slippage || 0),
    });
  }, [poolState, selectedPool, swapForm]);

  /* ── persistence ── */
  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved) setCustomPools(JSON.parse(saved));
    setHasMetaMask(!!window.ethereum);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(customPools));
  }, [customPools]);

  /* ── wallet listeners ── */
  useEffect(() => {
    if (!window.ethereum) return;
    const injected = new ethers.BrowserProvider(window.ethereum);
    setBrowserProvider(injected);
    setProvider(injected);

    // Only restore the session if the user explicitly connected before.
    // Without this guard, MetaMask's cached permission causes auto-reconnect on every reload.
    if (localStorage.getItem(WALLET_CONNECTED_KEY) === "true") {
      void syncInjectedWallet(injected);
    }

    const onAccountsChanged = async (accounts) => {
      if (!accounts.length) {
        // User disconnected from within MetaMask — clear the flag too
        localStorage.removeItem(WALLET_CONNECTED_KEY);
        setSigner(null);
        setAddress("");
        setWalletStatus("idle");
        return;
      }
      const s = await injected.getSigner();
      setSigner(s);
      setAddress(accounts[0]);
      setWalletStatus("connected");
    };
    const onChainChanged = (chainId) => {
      syncNetworkState(chainId);
      void syncInjectedWallet(injected);
    };

    window.ethereum.on("accountsChanged", onAccountsChanged);
    window.ethereum.on("chainChanged", onChainChanged);
    return () => {
      window.ethereum.removeListener("accountsChanged", onAccountsChanged);
      window.ethereum.removeListener("chainChanged", onChainChanged);
    };
  }, [syncInjectedWallet, syncNetworkState]);

  /* ── auto-refresh ── */
  useEffect(() => {
    if (!provider || !address) return;
    void refreshWalletState();
  }, [provider, address, selectedPoolId]);

  useEffect(() => {
    if (!provider || !selectedPool) return;
    void loadPoolState();
  }, [provider, selectedPool]);

  /* ════════════ wallet actions ════════════ */
  async function connectWallet() {
    if (!window.ethereum) {
      setTxState({
        type: "error",
        label: "No wallet found",
        message: "Please install MetaMask or a compatible browser wallet.",
      });
      return;
    }
    try {
      setWalletStatus("connecting");
      await window.ethereum.request({ method: "eth_requestAccounts" });
      await ensureLocalNetwork();
      const s = await browserProvider.getSigner();
      setSigner(s);
      setAddress(await s.getAddress());
      setProvider(browserProvider);
      setWalletStatus("connected");
      // Mark that the user explicitly chose to connect so reloads restore the session
      localStorage.setItem(WALLET_CONNECTED_KEY, "true");
    } catch (err) {
      setWalletStatus("error");
      setTxState({
        type: "error",
        label: "Connection failed",
        message: err?.message ?? "Could not connect wallet.",
      });
    }
  }

  async function disconnectWallet() {
    // Revoke MetaMask's site permission so it cannot silently reconnect on reload
    try {
      if (window.ethereum?.request) {
        await window.ethereum.request({
          method: "wallet_revokePermissions",
          params: [{ eth_accounts: {} }],
        });
      }
    } catch (err) {
      // wallet_revokePermissions may not be available on older MetaMask builds — safe to ignore
      console.warn("Could not revoke MetaMask permissions:", err);
    }

    // Clear the session flag so the reload guard does not restore the connection
    localStorage.removeItem(WALLET_CONNECTED_KEY);

    setSigner(null);
    setAddress("");
    setWalletStatus("idle");
    setNetworkReady(false);
    setNetworkLabel("Wallet not connected");
    setNetworkMessage(
      "Connect MetaMask to use the local NoFeeSwap deployment.",
    );
    setActiveChainId(null);
    setOperatorEnabled(false);
    setWalletBalances({});
    setPositionState(null);
  }

  async function ensureLocalNetwork() {
    const currentChainId = await window.ethereum.request({
      method: "eth_chainId",
    });
    if (syncNetworkState(currentChainId)) return;

    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: PREFERRED_LOCAL_CHAIN_ID }],
      });
    } catch (err) {
      if (err.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [LOCAL_CHAIN],
        });
      } else {
        throw err;
      }
    }

    const nextChainId = await window.ethereum.request({
      method: "eth_chainId",
    });
    if (!syncNetworkState(nextChainId)) {
      throw new Error(
        "MetaMask is still not on Hardhat 1337. Update the Localhost network in MetaMask to chain ID 1337, then retry.",
      );
    }
  }

  /* ════════════ chain reads ════════════ */
  async function refreshWalletState() {
    const nofeeswap = new ethers.Contract(
      DEPLOYMENT.contracts.nofeeswap,
      NOFEESWAP_ABI,
      provider,
    );
    setOperatorEnabled(
      await nofeeswap.isOperator(address, DEPLOYMENT.contracts.operator),
    );
    const nextMeta = {},
      nextBal = {};
    for (const token of DEPLOYMENT.tokens) {
      const c = new ethers.Contract(token.address, ERC20_ABI, provider);
      const [symbol, decimals, balance] = await Promise.all([
        c.symbol(),
        c.decimals(),
        c.balanceOf(address),
      ]);
      nextMeta[token.address] = { symbol, decimals };
      nextBal[token.address] = balance;
    }
    setTokenMeta(nextMeta);
    setWalletBalances(nextBal);
  }

  async function loadPoolState() {
    try {
      const access = new ethers.Contract(
        DEPLOYMENT.contracts.access,
        ACCESS_ABI,
        provider,
      );
      const dynamic = await access._readDynamicParams(
        DEPLOYMENT.contracts.nofeeswap,
        selectedPool.poolId,
      );

      let curve = [];
      try {
        curve = await access._readCurve(
          DEPLOYMENT.contracts.nofeeswap,
          selectedPool.poolId,
          dynamic.logPriceCurrent,
        );
      } catch {
        curve = [];
      }

      setPoolState({
        logPriceCurrent: dynamic.logPriceCurrent,
        sharesTotal: dynamic.sharesTotal,
        currentPrice: offsettedToPrice(dynamic.logPriceCurrent),
        curve,
      });
    } catch (error) {
      console.error("loadPoolState failed:", error);
    }
  }

  /* ════════════ tx wrapper ════════════ */
  async function withTransaction(label, work) {
    try {
      setTxState({
        type: "pending",
        label,
        message: "Awaiting wallet confirmation…",
      });
      const tx = await work();
      setTxState({
        type: "pending",
        label,
        message: "Broadcasting…",
        hash: tx.hash,
      });
      const receipt = await tx.wait();
      setTxState({
        type: "confirmed",
        label,
        message: `Confirmed in block ${receipt.blockNumber}.`,
        hash: tx.hash,
      });
      try {
        await refreshWalletState();
        await loadPoolState();
      } catch (refreshError) {
        console.error("Post-transaction refresh failed:", refreshError);
      }
      return receipt;
    } catch (err) {
      const msg =
        err?.shortMessage ||
        err?.reason ||
        err?.message ||
        "Transaction reverted.";
      setTxState({ type: "error", label, message: msg });
      throw err;
    }
  }

  /* contract actions */
  async function enableOperator() {
    if (!networkReady) {
      setTxState({
        type: "error",
        label: "Wrong network",
        message:
          "Switch MetaMask to Hardhat 1337 before enabling the operator.",
      });
      return;
    }
    const nofeeswap = new ethers.Contract(
      DEPLOYMENT.contracts.nofeeswap,
      NOFEESWAP_ABI,
      signer,
    );
    await withTransaction("Enable operator", () =>
      nofeeswap.setOperator(DEPLOYMENT.contracts.operator, true),
    );
    setOperatorEnabled(true);
  }

  async function ensureTokenApproval(tokenAddress, amount) {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    const allowance = await token.allowance(
      address,
      DEPLOYMENT.contracts.operator,
    );
    if (allowance >= amount) return;
    await withTransaction(
      `Approve ${tokenMeta[tokenAddress]?.symbol ?? "token"}`,
      () => token.approve(DEPLOYMENT.contracts.operator, amount),
    );
  }

  async function initializePool(event) {
    event.preventDefault();
    if (!networkReady) {
      setTxState({
        type: "error",
        label: "Wrong network",
        message: "Switch MetaMask to Hardhat 1337 before initializing a pool.",
      });
      return;
    }
    const nofeeswap = new ethers.Contract(
      DEPLOYMENT.contracts.nofeeswap,
      NOFEESWAP_ABI,
      signer,
    );
    const delegatee = new ethers.Interface(DELEGATEE_ABI);
    const sorted = sortTokenPair(
      DEPLOYMENT.tokens[0].address,
      DEPLOYMENT.tokens[1].address,
    );
    const kernel = [
      [0n, 0n],
      [
        BigInt(Math.max(1, Math.floor(kernelPoint.x * 1e15))),
        BigInt(Math.max(1, Math.floor(kernelPoint.y * 32768))),
      ],
    ];
    const curve = buildCurveFromPrice(Number(initForm.price), kernel[1][0]);
    const unsaltedPoolId = computeUnsaltedPoolId(Number(initForm.sequenceId));
    const poolId = computePoolId(address, unsaltedPoolId).toString();
    const payload = delegatee.encodeFunctionData("initialize", [
      unsaltedPoolId,
      ethers.getBigInt(sorted[0]),
      ethers.getBigInt(sorted[1]),
      BigInt(initForm.growthPortion),
      encodeKernelCompact(kernel),
      encodeCurve(curve),
      "0x",
    ]);
    await withTransaction("Initialize pool", () => nofeeswap.dispatch(payload));
    setCustomPools((prev) => [
      ...prev,
      {
        name: `Pool #${initForm.sequenceId}`,
        poolId,
        unsaltedPoolId: unsaltedPoolId.toString(),
        poolGrowthPortion: initForm.growthPortion,
        token0: sorted[0],
        token1: sorted[1],
        curve: curve.map((v) => v.toString()),
        kernelCompact: encodeKernelCompact(kernel).map((v) => v.toString()),
      },
    ]);
    setSelectedPoolId(poolId);
    setActiveTab("pool");
  }

  async function loadPosition() {
    if (!networkReady) {
      setTxState({
        type: "error",
        label: "Wrong network",
        message: "Switch MetaMask to Hardhat 1337 before loading a position.",
      });
      return;
    }
    const nofeeswap = new ethers.Contract(
      DEPLOYMENT.contracts.nofeeswap,
      NOFEESWAP_ABI,
      provider,
    );
    const raw = rangePricesToQ(
      Number(liquidityForm.lowerPrice),
      Number(liquidityForm.upperPrice),
    );
    const spacing =
      selectedPool?.curve?.length >= 2
        ? BigInt(selectedPool.curve[1]) - BigInt(selectedPool.curve[0])
        : null;
    const { qMin, qMax } = snapRangeToSpacing(raw.qMin, raw.qMax, spacing);
    const tagShares = ethers.solidityPackedKeccak256(
      ["uint256", "int256", "int256"],
      [selectedPool.poolId, qMin, qMax],
    );
    const shares = await nofeeswap.balanceOf(address, tagShares);
    setPositionState({
      qMin,
      qMax,
      priceMin: qToDisplayPrice(qMin),
      priceMax: qToDisplayPrice(qMax),
      tagShares,
      shares,
    });
  }

  async function submitLiquidity(event) {
    event.preventDefault();
    if (!networkReady) {
      setTxState({
        type: "error",
        label: "Wrong network",
        message: "Switch MetaMask to Hardhat 1337 before changing liquidity.",
      });
      return;
    }
    const nofeeswap = new ethers.Contract(
      DEPLOYMENT.contracts.nofeeswap,
      NOFEESWAP_ABI,
      signer,
    );
    const raw = rangePricesToQ(
      Number(liquidityForm.lowerPrice),
      Number(liquidityForm.upperPrice),
    );
    const spacing =
      selectedPool?.curve?.length >= 2
        ? BigInt(selectedPool.curve[1]) - BigInt(selectedPool.curve[0])
        : null;
    const { qMin, qMax } = snapRangeToSpacing(raw.qMin, raw.qMax, spacing);
    const amount = ethers.getBigInt(liquidityForm.shares);
    if (liquidityForm.mode === "mint") {
      for (const token of DEPLOYMENT.tokens)
        await ensureTokenApproval(token.address, ethers.MaxUint256);
      const sequence = buildMintSequence({
        nofeeswap: DEPLOYMENT.contracts.nofeeswap,
        token0: selectedPool.token0,
        token1: selectedPool.token1,
        poolId: selectedPool.poolId,
        qMin,
        qMax,
        shares: amount,
        deadline: deadlineFromNow(),
      });
      await withTransaction("Mint liquidity", () =>
        nofeeswap.unlock(DEPLOYMENT.contracts.operator, sequence),
      );
    } else {
      const sequence = buildBurnSequence({
        token0: selectedPool.token0,
        token1: selectedPool.token1,
        recipient: address,
        poolId: selectedPool.poolId,
        qMin,
        qMax,
        shares: amount,
        deadline: deadlineFromNow(),
      });
      await withTransaction("Burn liquidity", () =>
        nofeeswap.unlock(DEPLOYMENT.contracts.operator, sequence),
      );
    }
    await loadPosition();
  }

  async function submitSwap(event) {
    event.preventDefault();
    if (!networkReady) {
      setTxState({
        type: "error",
        label: "Wrong network",
        message: "Switch MetaMask to Hardhat 1337 before swapping.",
      });
      return;
    }
    if (!hasPoolLiquidity) {
      setTxState({
        type: "error",
        label: "No pool liquidity",
        message: "Mint liquidity into the selected pool before swapping.",
      });
      return;
    }
    const nofeeswap = new ethers.Contract(
      DEPLOYMENT.contracts.nofeeswap,
      NOFEESWAP_ABI,
      signer,
    );
    const tokenIn = swapForm.tokenIn;
    const decimals = tokenMeta[tokenIn]?.decimals ?? 18;
    const amount = ethers.parseUnits(swapForm.amountIn || "0", decimals);
    await ensureTokenApproval(tokenIn, amount);
    const token0In =
      tokenIn.toLowerCase() === selectedPool.token0.toLowerCase();
    const zeroForOne = token0In ? 0 : 1;
    const cp = poolState?.currentPrice ?? selectedPool.currentPrice;
    const slippage = Number(swapForm.slippage || 0);
    const limitPriceRaw =
      zeroForOne === 0 ? cp * (1 + slippage / 100) : cp * (1 - slippage / 100);
    const limitPrice = Math.max(limitPriceRaw, 1e-12);
    const sequence = buildSwapSequence({
      nofeeswap: DEPLOYMENT.contracts.nofeeswap,
      token0: selectedPool.token0,
      token1: selectedPool.token1,
      recipient: address,
      poolId: selectedPool.poolId,
      amountSpecified: amount,
      limitPrice,
      zeroForOne,
      deadline: deadlineFromNow(),
    });
    await withTransaction("Swap", () =>
      nofeeswap.unlock(DEPLOYMENT.contracts.operator, sequence),
    );
  }

  return (
    <>
      <div className="app">
        {/* ── HEADER ── */}
        <header className="header">
          <div className="header-brand">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <circle cx="14" cy="14" r="14" fill="url(#brandGrad)" />
              <path
                d="M8 14c0-3.3 2.7-6 6-6s6 2.7 6 6-2.7 6-6 6"
                stroke="#fff"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
              <circle cx="14" cy="14" r="2.5" fill="#fff" />
              <defs>
                <linearGradient id="brandGrad" x1="0" y1="0" x2="28" y2="28">
                  <stop stopColor="#2dd4bf" />
                  <stop offset="1" stopColor="#0f766e" />
                </linearGradient>
              </defs>
            </svg>
            <span className="header-title">
              NoFeeSwap <em>Workbench</em>
            </span>
          </div>
          <ConnectionPanel
            walletStatus={walletStatus}
            address={address}
            networkReady={networkReady}
            hasMetaMask={hasMetaMask}
            networkLabel={networkLabel}
            networkMessage={networkMessage}
            onConnect={connectWallet}
            onDisconnect={disconnectWallet}
            onSwitchNetwork={ensureLocalNetwork}
          />
        </header>

        {/* ── TX TOAST ── */}
        <TxToast txState={txState} onDismiss={() => setTxState(null)} />

        {/* ── WALLET GATE ── */}
        {!address && (
          <div className="gate">
            <div className="gate-inner">
              <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
                <circle
                  cx="28"
                  cy="28"
                  r="28"
                  fill="url(#gateGrad)"
                  opacity=".12"
                />
                <circle
                  cx="28"
                  cy="28"
                  r="20"
                  fill="url(#gateGrad)"
                  opacity=".18"
                />
                <path
                  d="M18 28c0-5.5 4.5-10 10-10s10 4.5 10 10-4.5 10-10 10"
                  stroke="url(#gateGrad)"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                />
                <circle cx="28" cy="28" r="4" fill="url(#gateGrad)" />
                <defs>
                  <linearGradient id="gateGrad" x1="0" y1="0" x2="56" y2="56">
                    <stop stopColor="#2dd4bf" />
                    <stop offset="1" stopColor="#0f766e" />
                  </linearGradient>
                </defs>
              </svg>
              <h2>Connect your wallet to begin</h2>
              <p>
                Interact with pools, manage liquidity, and execute swaps on your
                local Hardhat network.
              </p>
              {!hasMetaMask ? (
                <a
                  className="btn btn-primary"
                  href="https://metamask.io/download/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Install MetaMask
                </a>
              ) : (
                <button
                  className="btn btn-primary"
                  onClick={connectWallet}
                  disabled={walletStatus === "connecting"}
                >
                  {walletStatus === "connecting" ? (
                    <>
                      <Spinner /> Connecting…
                    </>
                  ) : (
                    "Connect MetaMask"
                  )}
                </button>
              )}
              <div className="gate-meta">
                <span>
                  RPC: <code>{DEPLOYMENT.rpcUrl}</code>
                </span>
                <span>
                  Chain ID: <code>{DEPLOYMENT.chainId}</code>
                </span>
              </div>
            </div>
          </div>
        )}

        {/* ── MAIN CONTENT (requires wallet) ── */}
        {address && (
          <>
            {/* Operator warning banner */}
            {!operatorEnabled && (
              <div className="operator-banner">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M8 1.5L14.5 13H1.5L8 1.5z"
                    stroke="#f59e0b"
                    strokeWidth="1.5"
                    fill="none"
                  />
                  <path
                    d="M8 6v3M8 11v.5"
                    stroke="#f59e0b"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
                <span>
                  Operator approval required for liquidity and swap actions.
                </span>
                <button
                  className="btn btn-sm btn-warning"
                  onClick={enableOperator}
                >
                  Enable Operator
                </button>
              </div>
            )}

            {/* ── TOP STATS ROW ── */}
            <div className="stats-row">
              <StatCard
                label="Wallet"
                value={compact(address)}
                sub="Connected"
                accent="green"
              />
              <StatCard
                label="Spot Price"
                value={currentPrice ? currentPrice.toFixed(6) : "Loading…"}
                sub={selectedPool?.name ?? ""}
                accent="teal"
              />
              <StatCard
                label="Pool Shares"
                value={poolState?.sharesTotal?.toString() ?? "—"}
                sub="Total liquidity"
                accent="blue"
              />
              <StatCard
                label="Network"
                value={networkReady ? networkLabel : "Switch needed"}
                sub={
                  networkReady
                    ? `${networkMessage}${activeChainId ? ` (${activeChainId})` : ""}`
                    : networkMessage
                }
                accent={networkReady ? "green" : "amber"}
              />
            </div>

            {/* ── TABS ── */}
            <div className="tabs">
              {[
                { id: "pool", label: "Pool State" },
                { id: "liquidity", label: "Liquidity" },
                { id: "swap", label: "Swap" },
                { id: "init", label: "Initialize" },
              ].map((tab) => (
                <button
                  key={tab.id}
                  className={`tab ${activeTab === tab.id ? "active" : ""}`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* ── POOL STATE TAB ── */}
            {activeTab === "pool" && (
              <div className="tab-content grid-two">
                {/* Pool Selector */}
                <div className="card">
                  <div className="card-header">
                    <h3>Pool State</h3>
                    <span className="badge badge-teal">Live</span>
                  </div>
                  <div className="field-group">
                    <label className="field-label">Active Pool</label>
                    <select
                      className="input"
                      value={selectedPoolId}
                      onChange={(e) => setSelectedPoolId(e.target.value)}
                    >
                      {pools.map((pool) => (
                        <option key={pool.poolId} value={pool.poolId}>
                          {pool.name ?? `Pool ${pool.poolId.slice(0, 10)}…`}
                        </option>
                      ))}
                    </select>
                  </div>
                  {selectedPool && (
                    <>
                      <div className="info-row">
                        <span>Pool ID</span>
                        <code className="mono">
                          {compact(selectedPool.poolId)}
                        </code>
                      </div>
                      <div className="info-row">
                        <span>Token 0</span>
                        <code className="mono">
                          {compact(selectedPool.token0)}
                        </code>
                      </div>
                      <div className="info-row">
                        <span>Token 1</span>
                        <code className="mono">
                          {compact(selectedPool.token1)}
                        </code>
                      </div>
                      <div className="info-row">
                        <span>Spot price</span>
                        <strong>{currentPrice?.toFixed(6) ?? "—"}</strong>
                      </div>
                      <div className="info-row">
                        <span>Shares (total)</span>
                        <strong>
                          {poolState?.sharesTotal?.toString() ?? "Loading…"}
                        </strong>
                      </div>
                      {selectedPool.curve?.length > 0 && (
                        <div className="sparkline-wrap">
                          <p className="field-label">Curve shape</p>
                          <Sparkline curve={selectedPool.curve.map(Number)} />
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Wallet balances */}
                <div className="card">
                  <div className="card-header">
                    <h3>Token Balances</h3>
                  </div>
                  {DEPLOYMENT.tokens.map((token) => {
                    const meta = tokenMeta[token.address];
                    const balance = walletBalances[token.address];
                    return (
                      <div key={token.address} className="balance-row">
                        <div className="token-icon">
                          {(meta?.symbol ?? token.label).slice(0, 2)}
                        </div>
                        <div className="token-info">
                          <span className="token-symbol">
                            {meta?.symbol ?? token.label}
                          </span>
                          <code className="mono small">
                            {compact(token.address)}
                          </code>
                        </div>
                        <div className="token-amount">
                          {formatUnits(balance, meta?.decimals)}
                        </div>
                      </div>
                    );
                  })}
                  <div className="info-row mt">
                    <span>Operator status</span>
                    {operatorEnabled ? (
                      <span className="badge badge-green">Enabled ✓</span>
                    ) : (
                      <span className="badge badge-amber">Not approved</span>
                    )}
                  </div>
                  <p className="caption">
                    Connect the Hardhat owner account{" "}
                    <code>{compact(DEPLOYMENT.deployer.owner)}</code> to access
                    pre-minted balances.
                  </p>
                </div>
              </div>
            )}

            {/* ── LIQUIDITY TAB ── */}
            {activeTab === "liquidity" && (
              <div className="tab-content grid-two">
                <div className="card">
                  <div className="card-header">
                    <h3>Manage Liquidity</h3>
                  </div>

                  {/* Mode switcher */}
                  <div className="segmented">
                    {["mint", "burn"].map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={`segment ${liquidityForm.mode === mode ? "active" : ""}`}
                        onClick={() =>
                          setLiquidityForm((f) => ({ ...f, mode }))
                        }
                      >
                        {mode === "mint" ? "➕ Mint" : "🔥 Burn"}
                      </button>
                    ))}
                  </div>

                  <form className="form-stack" onSubmit={submitLiquidity}>
                    <FieldInput
                      label="Lower price"
                      hint="Price floor of your range"
                      value={liquidityForm.lowerPrice}
                      onChange={(v) =>
                        setLiquidityForm((f) => ({ ...f, lowerPrice: v }))
                      }
                    />
                    <FieldInput
                      label="Upper price"
                      hint="Price ceiling of your range"
                      value={liquidityForm.upperPrice}
                      onChange={(v) =>
                        setLiquidityForm((f) => ({ ...f, upperPrice: v }))
                      }
                    />
                    <FieldInput
                      label="Shares"
                      hint="Amount of liquidity shares (raw bigint)"
                      value={liquidityForm.shares}
                      onChange={(v) =>
                        setLiquidityForm((f) => ({ ...f, shares: v }))
                      }
                    />
                    <div className="btn-row">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={loadPosition}
                        disabled={!address}
                      >
                        Load Position
                      </button>
                      <button
                        type="submit"
                        className={`btn ${liquidityForm.mode === "mint" ? "btn-primary" : "btn-danger"}`}
                        disabled={!signer || !operatorEnabled}
                      >
                        {liquidityForm.mode === "mint"
                          ? "Mint Liquidity"
                          : "Burn Liquidity"}
                      </button>
                    </div>
                    {!operatorEnabled && (
                      <p className="form-warning">Operator approval needed.</p>
                    )}
                  </form>
                </div>

                {/* Position info */}
                <div className="card">
                  <div className="card-header">
                    <h3>Your Position</h3>
                  </div>
                  {positionState ? (
                    <>
                      <div className="range-visual">
                        <div className="range-bar">
                          <span className="range-label left">
                            {positionState.priceMin.toFixed(4)}
                          </span>
                          <div className="range-fill" />
                          <span className="range-label right">
                            {positionState.priceMax.toFixed(4)}
                          </span>
                        </div>
                        <p className="field-label center">Price range</p>
                      </div>
                      <div className="info-row">
                        <span>Current shares</span>
                        <strong>{positionState.shares.toString()}</strong>
                      </div>
                      <div className="info-row">
                        <span>Position tag</span>
                        <code className="mono small">
                          {compact(positionState.tagShares)}
                        </code>
                      </div>
                    </>
                  ) : (
                    <div className="empty-state">
                      <p>No position loaded yet.</p>
                      <p className="caption">
                        Set your price range and click "Load Position".
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── SWAP TAB ── */}
            {activeTab === "swap" && (
              <div className="tab-content swap-layout">
                <div className="card swap-card">
                  <div className="card-header">
                    <h3>Swap Tokens</h3>
                    <span className="badge badge-blue">Exact In</span>
                  </div>

                  <form className="form-stack" onSubmit={submitSwap}>
                    <div className="field-group">
                      <label className="field-label">Token In</label>
                      <select
                        className="input"
                        value={swapForm.tokenIn}
                        onChange={(e) =>
                          setSwapForm((f) => ({
                            ...f,
                            tokenIn: e.target.value,
                          }))
                        }
                      >
                        {DEPLOYMENT.tokens.map((token) => (
                          <option key={token.address} value={token.address}>
                            {tokenMeta[token.address]?.symbol ?? token.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <FieldInput
                      label="Amount In"
                      hint="Exact input amount"
                      value={swapForm.amountIn}
                      onChange={(v) =>
                        setSwapForm((f) => ({ ...f, amountIn: v }))
                      }
                      type="number"
                      min="0"
                      step="any"
                    />
                    <FieldInput
                      label="Slippage Tolerance"
                      hint="Percentage (e.g. 1 = 1%)"
                      value={swapForm.slippage}
                      onChange={(v) =>
                        setSwapForm((f) => ({ ...f, slippage: v }))
                      }
                      type="number"
                      min="0"
                      step="any"
                      suffix="%"
                    />

                    {/* Preview */}
                    {swapPreview && (
                      <div className="swap-preview">
                        <div className="preview-row">
                          <span>Estimated output</span>
                          <strong className="preview-value">
                            {swapPreview.estimatedOutput.toFixed(6)}
                          </strong>
                        </div>
                        <div className="preview-row">
                          <span>Price impact</span>
                          <strong
                            className={`preview-value ${swapPreview.priceImpact > 2 ? "text-amber" : "text-green"}`}
                          >
                            {swapPreview.priceImpact.toFixed(2)}%
                          </strong>
                        </div>
                        <p className="caption">
                          Estimate based on spot price and slippage cap.
                        </p>
                      </div>
                    )}

                    <button
                      type="submit"
                      className="btn btn-primary btn-full"
                      disabled={
                        !signer || !operatorEnabled || !hasPoolLiquidity
                      }
                    >
                      {!signer
                        ? "Connect Wallet"
                        : !operatorEnabled
                          ? "Enable Operator First"
                          : !hasPoolLiquidity
                            ? "Mint Liquidity First"
                            : "Execute Swap"}
                    </button>
                  </form>
                </div>
              </div>
            )}

            {/* ── INITIALIZE TAB ── */}
            {activeTab === "init" && (
              <div className="tab-content">
                <div className="card">
                  <div className="card-header">
                    <h3>Initialize Pool</h3>
                    <span className="badge badge-purple">Advanced</span>
                  </div>
                  <form className="grid-form" onSubmit={initializePool}>
                    <FieldInput
                      label="Sequence ID"
                      hint="Unique integer per deployer address"
                      value={initForm.sequenceId}
                      onChange={(v) =>
                        setInitForm((f) => ({ ...f, sequenceId: v }))
                      }
                    />
                    <FieldInput
                      label="Initial Price"
                      hint="token1 per token0"
                      value={initForm.price}
                      onChange={(v) => setInitForm((f) => ({ ...f, price: v }))}
                    />
                    <FieldInput
                      label="Growth Portion"
                      hint="Pool growth portion (bigint)"
                      value={initForm.growthPortion}
                      onChange={(v) =>
                        setInitForm((f) => ({ ...f, growthPortion: v }))
                      }
                    />
                    <div className="field-group">
                      <label className="field-label">Fee Tier Preset</label>
                      <select
                        className="input"
                        value={initForm.preset}
                        onChange={(e) => {
                          const idx = Number(e.target.value);
                          const preset = POOL_PRESETS[idx];
                          setInitForm((f) => ({ ...f, preset: idx }));
                          setKernelPoint({
                            x: Number(preset.spacingX59) / 1e15,
                            y: Number(preset.verticalX15) / 32768,
                          });
                        }}
                      >
                        {POOL_PRESETS.map((p, i) => (
                          <option key={p.label} value={i}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="kernel-section">
                      <div className="kernel-header">
                        <h4>Kernel Shape</h4>
                        <p className="caption">
                          Drag sliders to adjust width & height of the
                          single-segment kernel.
                        </p>
                      </div>
                      <KernelEditor
                        kernelPoint={kernelPoint}
                        onChange={setKernelPoint}
                      />
                    </div>

                    <button
                      type="submit"
                      className="btn btn-primary btn-full"
                      disabled={!signer}
                    >
                      {!signer ? "Connect Wallet First" : "Initialize Pool"}
                    </button>
                  </form>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

function WalletButton({
  walletStatus,
  address,
  networkReady,
  hasMetaMask,
  onConnect,
  onDisconnect,
}) {
  const [open, setOpen] = useState(false);

  if (!address) {
    return (
      <button
        className="btn btn-primary btn-sm"
        onClick={onConnect}
        disabled={walletStatus === "connecting"}
      >
        {walletStatus === "connecting" ? (
          <>
            <Spinner /> Connecting…
          </>
        ) : (
          "Connect Wallet"
        )}
      </button>
    );
  }

  return (
    <div className="wallet-pill-wrap">
      <button className="wallet-pill" onClick={() => setOpen((v) => !v)}>
        <span className={`dot ${networkReady ? "dot-green" : "dot-amber"}`} />
        <span className="mono">{compact(address)}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path
            d={open ? "M2 8l4-4 4 4" : "M2 4l4 4 4-4"}
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
      {open && (
        <div className="wallet-dropdown">
          <div className="wallet-dropdown-addr">
            <span className="field-label">Address</span>
            <code className="mono">{address}</code>
          </div>
          <div className="wallet-dropdown-info">
            <span
              className={
                networkReady ? "badge badge-green" : "badge badge-amber"
              }
            >
              {networkReady ? "Local network ✓" : "Wrong network"}
            </span>
          </div>
          <button
            className="btn btn-danger btn-sm btn-full"
            onClick={() => {
              onDisconnect();
              setOpen(false);
            }}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

function TxToast({ txState, onDismiss }) {
  useEffect(() => {
    if (txState?.type === "confirmed") {
      const t = setTimeout(onDismiss, 8000);
      return () => clearTimeout(t);
    }
  }, [txState]);

  if (!txState) return null;
  const icons = { pending: "⏳", confirmed: "✅", error: "❌" };
  return (
    <div className={`toast toast-${txState.type}`}>
      <span className="toast-icon">{icons[txState.type]}</span>
      <div className="toast-body">
        <strong>{txState.label}</strong>
        <span>{txState.message}</span>
        {txState.hash && (
          <code className="mono small">{compact(txState.hash)}</code>
        )}
      </div>
      <button className="toast-close" onClick={onDismiss}>
        ✕
      </button>
    </div>
  );
}

function StatCard({ label, value, sub, accent }) {
  return (
    <div className={`stat-card accent-${accent}`}>
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      <span className="stat-sub">{sub}</span>
    </div>
  );
}

function FieldInput({
  label,
  hint,
  value,
  onChange,
  type = "text",
  min,
  step,
  suffix,
}) {
  return (
    <div className="field-group">
      <label className="field-label">{label}</label>
      <div className="input-wrap">
        <input
          className="input"
          type={type}
          min={min}
          step={step}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {suffix && <span className="input-suffix">{suffix}</span>}
      </div>
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

function KernelEditor({ kernelPoint, onChange }) {
  const W = 320,
    H = 180;
  const x = Math.max(24, Math.min(W - 24, (kernelPoint.x / 8) * (W - 48) + 24));
  const y = Math.max(20, Math.min(H - 20, H - kernelPoint.y * (H - 40) - 20));
  return (
    <div className="kernel-editor">
      <svg viewBox={`0 0 ${W} ${H}`} className="kernel-svg">
        <defs>
          <linearGradient id="kfill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#2dd4bf" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#2dd4bf" stopOpacity="0.05" />
          </linearGradient>
        </defs>
        <rect width={W} height={H} rx="12" className="kernel-bg" />
        <path
          d={`M 24 ${H - 20} L ${x} ${y} L ${W - 24} 20 L ${W - 24} ${H - 20} Z`}
          fill="url(#kfill)"
        />
        <path
          d={`M 24 ${H - 20} L ${x} ${y} L ${W - 24} 20`}
          className="kernel-line"
        />
        <circle cx={x} cy={y} r="7" className="kernel-node" />
      </svg>
      <div className="slider-group">
        <div className="slider-row">
          <span className="field-label">
            Width <em>{kernelPoint.x.toFixed(2)}</em>
          </span>
          <input
            type="range"
            min="0.4"
            max="8"
            step="0.1"
            value={kernelPoint.x}
            onChange={(e) =>
              onChange((f) => ({ ...f, x: Number(e.target.value) }))
            }
          />
        </div>
        <div className="slider-row">
          <span className="field-label">
            Height <em>{kernelPoint.y.toFixed(2)}</em>
          </span>
          <input
            type="range"
            min="0.1"
            max="1"
            step="0.01"
            value={kernelPoint.y}
            onChange={(e) =>
              onChange((f) => ({ ...f, y: Number(e.target.value) }))
            }
          />
        </div>
      </div>
    </div>
  );
}

function Sparkline({ curve }) {
  if (!curve?.length) return null;
  const min = Math.min(...curve),
    max = Math.max(...curve);
  const W = 300,
    H = 80;
  const pts = curve
    .map((v, i) => {
      const px = (i / Math.max(1, curve.length - 1)) * W;
      const py = H - ((v - min) / Math.max(1, max - min)) * H;
      return `${px},${py}`;
    })
    .join(" ");
  const area =
    `M 0 ${H} L ` +
    curve
      .map((v, i) => {
        const px = (i / Math.max(1, curve.length - 1)) * W;
        const py = H - ((v - min) / Math.max(1, max - min)) * H;
        return `${px},${py}`;
      })
      .join(" L ") +
    ` L ${W} ${H} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="sparkline">
      <defs>
        <linearGradient id="spArea" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#2dd4bf" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#2dd4bf" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#spArea)" />
      <polyline fill="none" stroke="#2dd4bf" strokeWidth="2.5" points={pts} />
    </svg>
  );
}

function Spinner() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="spinner">
      <circle
        cx="7"
        cy="7"
        r="5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray="22"
        strokeDashoffset="8"
      />
    </svg>
  );
}
