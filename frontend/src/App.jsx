import { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { ACCESS_ABI, DELEGATEE_ABI, ERC20_ABI, NOFEESWAP_ABI } from "./lib/abi";
import { DEPLOYMENT, LOCAL_CHAIN, POOL_PRESETS } from "./lib/config";
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
  sortTokenPair
} from "./lib/nofeeswap";

const STORAGE_KEY = "nofeeswap-local-pools";

function App() {
  const [provider, setProvider] = useState(null);
  const [browserProvider, setBrowserProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [address, setAddress] = useState("");
  const [networkReady, setNetworkReady] = useState(false);
  const [tokenMeta, setTokenMeta] = useState({});
  const [walletBalances, setWalletBalances] = useState({});
  const [txState, setTxState] = useState(null);
  const [operatorEnabled, setOperatorEnabled] = useState(false);
  const [poolState, setPoolState] = useState(null);
  const [selectedPoolId, setSelectedPoolId] = useState(DEPLOYMENT.samplePool.poolId);
  const [customPools, setCustomPools] = useState([]);
  const [initForm, setInitForm] = useState({
    sequenceId: "2",
    price: "1.10",
    growthPortion: DEPLOYMENT.samplePool.poolGrowthPortion,
    preset: 2
  });
  const [kernelPoint, setKernelPoint] = useState({
    x: Number(POOL_PRESETS[2].spacingX59) / 1e15,
    y: Number(POOL_PRESETS[2].verticalX15) / 32768
  });
  const [liquidityForm, setLiquidityForm] = useState({
    mode: "mint",
    lowerPrice: "0.90",
    upperPrice: "1.20",
    shares: "1000000000000000000"
  });
  const [positionState, setPositionState] = useState(null);
  const [swapForm, setSwapForm] = useState({
    tokenIn: DEPLOYMENT.tokens[0].address,
    amountIn: "1",
    slippage: "1"
  });

  const pools = useMemo(() => [DEPLOYMENT.samplePool, ...customPools].map(makePoolSummary), [customPools]);
  const selectedPool = useMemo(() => pools.find((pool) => pool.poolId === selectedPoolId) ?? pools[0], [pools, selectedPoolId]);

  const swapPreview = useMemo(() => {
    if (!selectedPool) return null;
    const amount = Number(swapForm.amountIn || 0);
    if (!amount) return null;
    const currentPrice = poolState?.currentPrice ?? selectedPool.currentPrice;
    const zeroForOne = swapForm.tokenIn.toLowerCase() === selectedPool.token0.toLowerCase();
    return estimateSwapFromSpot({
      currentPrice,
      amount,
      zeroForOne,
      slippage: Number(swapForm.slippage || 0)
    });
  }, [poolState, selectedPool, swapForm]);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved) setCustomPools(JSON.parse(saved));
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(customPools));
  }, [customPools]);

  useEffect(() => {
    if (!window.ethereum) return;
    const injected = new ethers.BrowserProvider(window.ethereum);
    setBrowserProvider(injected);
    setProvider(injected);

    const handleAccountsChanged = async (accounts) => {
      if (!accounts.length) {
        setSigner(null);
        setAddress("");
        return;
      }
      const nextSigner = await injected.getSigner();
      setSigner(nextSigner);
      setAddress(accounts[0]);
    };

    const handleChainChanged = () => window.location.reload();
    window.ethereum.on("accountsChanged", handleAccountsChanged);
    window.ethereum.on("chainChanged", handleChainChanged);
    return () => {
      window.ethereum.removeListener("accountsChanged", handleAccountsChanged);
      window.ethereum.removeListener("chainChanged", handleChainChanged);
    };
  }, []);

  useEffect(() => {
    if (!provider || !address) return;
    void refreshWalletState();
  }, [provider, address, selectedPoolId]);

  useEffect(() => {
    if (!provider || !selectedPool) return;
    void loadPoolState();
  }, [provider, selectedPool]);

  async function connectWallet() {
    if (!window.ethereum) {
      setTxState({ type: "error", label: "MetaMask not detected", message: "Install MetaMask or another injected wallet." });
      return;
    }
    await window.ethereum.request({ method: "eth_requestAccounts" });
    await ensureLocalNetwork();
    const nextSigner = await browserProvider.getSigner();
    setSigner(nextSigner);
    setAddress(await nextSigner.getAddress());
    setProvider(browserProvider);
  }

  async function ensureLocalNetwork() {
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: LOCAL_CHAIN.chainId }] });
    } catch (error) {
      if (error.code === 4902) {
        await window.ethereum.request({ method: "wallet_addEthereumChain", params: [LOCAL_CHAIN] });
      } else {
        throw error;
      }
    }
    setNetworkReady(true);
  }

  async function refreshWalletState() {
    const nofeeswap = new ethers.Contract(DEPLOYMENT.contracts.nofeeswap, NOFEESWAP_ABI, provider);
    setOperatorEnabled(await nofeeswap.isOperator(address, DEPLOYMENT.contracts.operator));

    const nextMeta = {};
    const nextBalances = {};
    for (const token of DEPLOYMENT.tokens) {
      const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
      const [symbol, decimals, balance] = await Promise.all([
        contract.symbol(),
        contract.decimals(),
        contract.balanceOf(address)
      ]);
      nextMeta[token.address] = { symbol, decimals };
      nextBalances[token.address] = balance;
    }
    setTokenMeta(nextMeta);
    setWalletBalances(nextBalances);
  }

  async function loadPoolState() {
    const access = new ethers.Contract(DEPLOYMENT.contracts.access, ACCESS_ABI, provider);
    const dynamic = await access._readDynamicParams(DEPLOYMENT.contracts.nofeeswap, selectedPool.poolId);
    const curve = await access._readCurve(DEPLOYMENT.contracts.nofeeswap, selectedPool.poolId, dynamic.logPriceCurrent);
    setPoolState({
      logPriceCurrent: dynamic.logPriceCurrent,
      sharesTotal: dynamic.sharesTotal,
      currentPrice: offsettedToPrice(dynamic.logPriceCurrent),
      curve
    });
  }

  async function withTransaction(label, work) {
    try {
      setTxState({ type: "pending", label, message: "Waiting for wallet confirmation..." });
      const tx = await work();
      setTxState({ type: "pending", label, message: "Transaction pending on chain...", hash: tx.hash });
      const receipt = await tx.wait();
      setTxState({ type: "confirmed", label, message: `Confirmed in block ${receipt.blockNumber}.`, hash: tx.hash });
      await refreshWalletState();
      await loadPoolState();
      return receipt;
    } catch (error) {
      const message = error?.shortMessage || error?.reason || error?.message || "Transaction reverted.";
      setTxState({ type: "error", label, message });
      throw error;
    }
  }

  async function enableOperator() {
    const nofeeswap = new ethers.Contract(DEPLOYMENT.contracts.nofeeswap, NOFEESWAP_ABI, signer);
    await withTransaction("Enable operator", () => nofeeswap.setOperator(DEPLOYMENT.contracts.operator, true));
    setOperatorEnabled(true);
  }

  async function ensureTokenApproval(tokenAddress, amount) {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    const allowance = await token.allowance(address, DEPLOYMENT.contracts.operator);
    if (allowance >= amount) return;
    await withTransaction(`Approve ${tokenMeta[tokenAddress]?.symbol ?? "token"}`, () =>
      token.approve(DEPLOYMENT.contracts.operator, amount)
    );
  }

  async function initializePool(event) {
    event.preventDefault();
    const nofeeswap = new ethers.Contract(DEPLOYMENT.contracts.nofeeswap, NOFEESWAP_ABI, signer);
    const delegatee = new ethers.Interface(DELEGATEE_ABI);
    const sorted = sortTokenPair(DEPLOYMENT.tokens[0].address, DEPLOYMENT.tokens[1].address);
    const kernel = [[0n, 0n], [BigInt(Math.max(1, Math.floor(kernelPoint.x * 1e15))), BigInt(Math.max(1, Math.floor(kernelPoint.y * 32768)))]];
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
      "0x"
    ]);

    await withTransaction("Initialize pool", () => nofeeswap.dispatch(payload));

    setCustomPools((current) => [
      ...current,
      {
        name: `Pool #${initForm.sequenceId}`,
        poolId,
        unsaltedPoolId: unsaltedPoolId.toString(),
        poolGrowthPortion: initForm.growthPortion,
        token0: sorted[0],
        token1: sorted[1],
        curve: curve.map((value) => value.toString()),
        kernelCompact: encodeKernelCompact(kernel).map((value) => value.toString())
      }
    ]);
    setSelectedPoolId(poolId);
  }

  async function loadPosition() {
    const nofeeswap = new ethers.Contract(DEPLOYMENT.contracts.nofeeswap, NOFEESWAP_ABI, provider);
    const { qMin, qMax } = rangePricesToQ(Number(liquidityForm.lowerPrice), Number(liquidityForm.upperPrice));
    const tagShares = ethers.solidityPackedKeccak256(["uint256", "int256", "int256"], [selectedPool.poolId, qMin, qMax]);
    const shares = await nofeeswap.balanceOf(address, tagShares);
    setPositionState({
      qMin,
      qMax,
      priceMin: qToDisplayPrice(qMin),
      priceMax: qToDisplayPrice(qMax),
      tagShares,
      shares
    });
  }

  async function submitLiquidity(event) {
    event.preventDefault();
    const nofeeswap = new ethers.Contract(DEPLOYMENT.contracts.nofeeswap, NOFEESWAP_ABI, signer);
    const { qMin, qMax } = rangePricesToQ(Number(liquidityForm.lowerPrice), Number(liquidityForm.upperPrice));
    const amount = ethers.getBigInt(liquidityForm.shares);

    if (liquidityForm.mode === "mint") {
      for (const token of DEPLOYMENT.tokens) {
        await ensureTokenApproval(token.address, ethers.MaxUint256);
      }
      const sequence = buildMintSequence({
        nofeeswap: DEPLOYMENT.contracts.nofeeswap,
        token0: selectedPool.token0,
        token1: selectedPool.token1,
        poolId: selectedPool.poolId,
        qMin,
        qMax,
        shares: amount,
        deadline: deadlineFromNow()
      });
      await withTransaction("Mint liquidity", () => nofeeswap.unlock(DEPLOYMENT.contracts.operator, sequence));
    } else {
      const sequence = buildBurnSequence({
        token0: selectedPool.token0,
        token1: selectedPool.token1,
        recipient: address,
        poolId: selectedPool.poolId,
        qMin,
        qMax,
        shares: amount,
        deadline: deadlineFromNow()
      });
      await withTransaction("Burn liquidity", () => nofeeswap.unlock(DEPLOYMENT.contracts.operator, sequence));
    }
    await loadPosition();
  }

  async function submitSwap(event) {
    event.preventDefault();
    const nofeeswap = new ethers.Contract(DEPLOYMENT.contracts.nofeeswap, NOFEESWAP_ABI, signer);
    const tokenIn = swapForm.tokenIn;
    const decimals = tokenMeta[tokenIn]?.decimals ?? 18;
    const amount = ethers.parseUnits(swapForm.amountIn || "0", decimals);
    await ensureTokenApproval(tokenIn, amount);

    const zeroForOne = tokenIn.toLowerCase() === selectedPool.token0.toLowerCase() ? 0 : 1;
    const currentPrice = poolState?.currentPrice ?? selectedPool.currentPrice;
    const slippage = Number(swapForm.slippage || 0);
    const limitPrice = zeroForOne === 0 ? currentPrice * (1 - slippage / 100) : currentPrice * (1 + slippage / 100);

    const sequence = buildSwapSequence({
      nofeeswap: DEPLOYMENT.contracts.nofeeswap,
      token0: selectedPool.token0,
      token1: selectedPool.token1,
      recipient: address,
      poolId: selectedPool.poolId,
      amountSpecified: amount,
      limitPrice,
      zeroForOne,
      deadline: deadlineFromNow()
    });

    await withTransaction("Swap", () => nofeeswap.unlock(DEPLOYMENT.contracts.operator, sequence));
  }

  const currentPrice = poolState?.currentPrice ?? selectedPool?.currentPrice;

  return (
    <div className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">NoFeeSwap Local</p>
          <h1>Protocol Workbench</h1>
          <p className="lede">MetaMask-connected local UI for pool initialization, liquidity management, and swaps on your Hardhat chain.</p>
        </div>
        <div className="walletCard">
          <button className="primaryButton" onClick={connectWallet}>{address ? "Connected" : "Connect MetaMask"}</button>
          <p>{address ? compact(address) : "Wallet not connected"}</p>
          <p>RPC: {DEPLOYMENT.rpcUrl}</p>
          <p>Chain: {DEPLOYMENT.chainId}</p>
          <p className={networkReady ? "ok" : "warn"}>{networkReady ? "Local network selected" : "Switch to Hardhat Local 31337"}</p>
        </div>
      </header>

      {txState ? (
        <div className={`txBanner ${txState.type}`}>
          <strong>{txState.label}</strong>
          <span>{txState.message}</span>
          {txState.hash ? <code>{compact(txState.hash)}</code> : null}
        </div>
      ) : null}

      <section className="gridTwo">
        <article className="panel">
          <h2>Wallet</h2>
          <div className="stack">
            <div className="row"><span>Operator approval</span><strong>{operatorEnabled ? "Enabled" : "Missing"}</strong></div>
            {!operatorEnabled && signer ? <button className="secondaryButton" onClick={enableOperator}>Enable Operator</button> : null}
            {DEPLOYMENT.tokens.map((token) => (
              <div className="row" key={token.address}>
                <span>{tokenMeta[token.address]?.symbol ?? token.label}</span>
                <strong>{formatUnits(walletBalances[token.address], tokenMeta[token.address]?.decimals ?? 18)}</strong>
              </div>
            ))}
            <p className="caption">For the pre-minted balances, connect the Hardhat owner account `{DEPLOYMENT.deployer.owner}` in MetaMask.</p>
          </div>
        </article>

        <article className="panel">
          <h2>Pool State</h2>
          <select className="input" value={selectedPoolId} onChange={(event) => setSelectedPoolId(event.target.value)}>
            {pools.map((pool) => <option key={pool.poolId} value={pool.poolId}>{pool.name ?? `Pool ${pool.poolId.slice(0, 10)}...`}</option>)}
          </select>
          {selectedPool ? (
            <div className="stack">
              <div className="metricCard"><span>Pool ID</span><strong>{compact(selectedPool.poolId)}</strong></div>
              <div className="metricGrid">
                <div><span>Current spot price</span><strong>{currentPrice?.toFixed(6)}</strong></div>
                <div><span>Total shares</span><strong>{poolState?.sharesTotal?.toString() ?? "Loading"}</strong></div>
              </div>
              <div className="curvePreview"><Sparkline curve={selectedPool.curve.map((item) => Number(item))} /></div>
            </div>
          ) : null}
        </article>
      </section>

      <section className="panel">
        <h2>Initialize Liquidity Pool</h2>
        <form className="gridForm" onSubmit={initializePool}>
          <label>Pool sequence id<input className="input" value={initForm.sequenceId} onChange={(event) => setInitForm((current) => ({ ...current, sequenceId: event.target.value }))} /></label>
          <label>Initial price (token1 per token0)<input className="input" value={initForm.price} onChange={(event) => setInitForm((current) => ({ ...current, price: event.target.value }))} /></label>
          <label>Pool growth portion<input className="input" value={initForm.growthPortion} onChange={(event) => setInitForm((current) => ({ ...current, growthPortion: event.target.value }))} /></label>
          <label>
            Fee tier preset
            <select className="input" value={initForm.preset} onChange={(event) => {
              const index = Number(event.target.value);
              const preset = POOL_PRESETS[index];
              setInitForm((current) => ({ ...current, preset: index }));
              setKernelPoint({ x: Number(preset.spacingX59) / 1e15, y: Number(preset.verticalX15) / 32768 });
            }}>
              {POOL_PRESETS.map((preset, index) => <option key={preset.label} value={index}>{preset.label}</option>)}
            </select>
          </label>
          <div className="kernelCard">
            <div><h3>Kernel editor</h3><p className="caption">Drag the single-segment kernel shape with width and height sliders.</p></div>
            <KernelEditor kernelPoint={kernelPoint} onChange={setKernelPoint} />
          </div>
          <button className="primaryButton wide" disabled={!signer}>Initialize Pool</button>
        </form>
      </section>

      <section className="gridTwo">
        <article className="panel">
          <h2>Manage Liquidity</h2>
          <form className="stack" onSubmit={submitLiquidity}>
            <div className="segmented">
              <button type="button" className={liquidityForm.mode === "mint" ? "segment active" : "segment"} onClick={() => setLiquidityForm((current) => ({ ...current, mode: "mint" }))}>Mint</button>
              <button type="button" className={liquidityForm.mode === "burn" ? "segment active" : "segment"} onClick={() => setLiquidityForm((current) => ({ ...current, mode: "burn" }))}>Burn</button>
            </div>
            <label>Lower price<input className="input" value={liquidityForm.lowerPrice} onChange={(event) => setLiquidityForm((current) => ({ ...current, lowerPrice: event.target.value }))} /></label>
            <label>Upper price<input className="input" value={liquidityForm.upperPrice} onChange={(event) => setLiquidityForm((current) => ({ ...current, upperPrice: event.target.value }))} /></label>
            <label>Shares<input className="input" value={liquidityForm.shares} onChange={(event) => setLiquidityForm((current) => ({ ...current, shares: event.target.value }))} /></label>
            <div className="buttonRow">
              <button type="button" className="secondaryButton" onClick={loadPosition} disabled={!address}>Load Position</button>
              <button className="primaryButton" disabled={!signer || !operatorEnabled}>{liquidityForm.mode === "mint" ? "Submit Mint" : "Submit Burn"}</button>
            </div>
          </form>
          {positionState ? (
            <div className="positionCard">
              <div className="row"><span>Range</span><strong>{positionState.priceMin.toFixed(4)} - {positionState.priceMax.toFixed(4)}</strong></div>
              <div className="row"><span>Current position</span><strong>{positionState.shares.toString()}</strong></div>
              <div className="row"><span>Position tag</span><code>{compact(positionState.tagShares)}</code></div>
            </div>
          ) : null}
        </article>

        <article className="panel">
          <h2>Swap</h2>
          <form className="stack" onSubmit={submitSwap}>
            <label>
              Token in
              <select className="input" value={swapForm.tokenIn} onChange={(event) => setSwapForm((current) => ({ ...current, tokenIn: event.target.value }))}>
                {DEPLOYMENT.tokens.map((token) => <option key={token.address} value={token.address}>{tokenMeta[token.address]?.symbol ?? token.label}</option>)}
              </select>
            </label>
            <label>Exact input amount<input className="input" value={swapForm.amountIn} onChange={(event) => setSwapForm((current) => ({ ...current, amountIn: event.target.value }))} /></label>
            <label>Slippage tolerance %<input className="input" value={swapForm.slippage} onChange={(event) => setSwapForm((current) => ({ ...current, slippage: event.target.value }))} /></label>
            {swapPreview ? (
              <div className="previewCard">
                <div className="row"><span>Estimated output</span><strong>{swapPreview.estimatedOutput.toFixed(6)}</strong></div>
                <div className="row"><span>Estimated price impact</span><strong>{swapPreview.priceImpact.toFixed(2)}%</strong></div>
                <p className="caption">Preview uses the selected pool’s current spot price and your slippage cap.</p>
              </div>
            ) : null}
            <button className="primaryButton" disabled={!signer || !operatorEnabled}>Submit Swap</button>
          </form>
        </article>
      </section>
    </div>
  );
}

function KernelEditor({ kernelPoint, onChange }) {
  const width = 320;
  const height = 180;
  const x = Math.max(24, Math.min(width - 24, (kernelPoint.x / 8) * (width - 48) + 24));
  const y = Math.max(20, Math.min(height - 20, height - kernelPoint.y * (height - 40) - 20));

  return (
    <div className="kernelEditor">
      <svg viewBox={`0 0 ${width} ${height}`}>
        <defs>
          <linearGradient id="kernel-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#0f766e" stopOpacity="0.6" />
            <stop offset="100%" stopColor="#0f766e" stopOpacity="0.08" />
          </linearGradient>
        </defs>
        <rect x="0" y="0" width={width} height={height} rx="18" className="kernelBackdrop" />
        <path d={`M 24 ${height - 20} L ${x} ${y} L ${width - 24} 20 L ${width - 24} ${height - 20} Z`} fill="url(#kernel-fill)" />
        <path d={`M 24 ${height - 20} L ${x} ${y} L ${width - 24} 20`} className="kernelLine" />
        <circle cx={x} cy={y} r="8" className="kernelNode" />
      </svg>
      <div className="sliderGroup">
        <label>Width<input type="range" min="0.4" max="8" step="0.1" value={kernelPoint.x} onChange={(event) => onChange((current) => ({ ...current, x: Number(event.target.value) }))} /></label>
        <label>Height<input type="range" min="0.1" max="1" step="0.01" value={kernelPoint.y} onChange={(event) => onChange((current) => ({ ...current, y: Number(event.target.value) }))} /></label>
      </div>
    </div>
  );
}

function Sparkline({ curve }) {
  if (!curve?.length) return null;
  const min = Math.min(...curve);
  const max = Math.max(...curve);
  const width = 300;
  const height = 80;
  const points = curve.map((value, index) => {
    const x = (index / Math.max(1, curve.length - 1)) * width;
    const y = height - ((value - min) / Math.max(1, max - min || 1)) * height;
    return `${x},${y}`;
  }).join(" ");
  return <svg viewBox={`0 0 ${width} ${height}`}><polyline fill="none" stroke="#ea580c" strokeWidth="3" points={points} /></svg>;
}

function compact(value) {
  const stringValue = String(value);
  return `${stringValue.slice(0, 8)}...${stringValue.slice(-6)}`;
}

function formatUnits(value, decimals) {
  if (value == null) return "0";
  return Number(ethers.formatUnits(value, decimals)).toFixed(4);
}

export default App;
