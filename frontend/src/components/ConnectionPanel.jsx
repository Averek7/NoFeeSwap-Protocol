import { useState } from "react";

function compact(value) {
  const s = String(value);
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

function Spinner() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="spinner">
      <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="22" strokeDashoffset="8" />
    </svg>
  );
}

export default function ConnectionPanel({
  walletStatus,
  address,
  networkReady,
  hasMetaMask,
  networkLabel,
  networkMessage,
  onConnect,
  onDisconnect,
  onSwitchNetwork,
}) {
  const [open, setOpen] = useState(false);

  if (!address) {
    return (
      <button
        className="btn btn-primary btn-sm"
        onClick={onConnect}
        disabled={!hasMetaMask || walletStatus === "connecting"}
      >
        {walletStatus === "connecting" ? <><Spinner /> Connecting...</> : "Connect Wallet"}
      </button>
    );
  }

  return (
    <div className="connection-panel">
      <div className="wallet-pill-wrap">
        <button className="wallet-pill" onClick={() => setOpen((v) => !v)}>
          <span className={`dot ${networkReady ? "dot-green" : "dot-amber"}`} />
          <span className="mono">{compact(address)}</span>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d={open ? "M2 8l4-4 4 4" : "M2 4l4 4 4-4"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        {open && (
          <div className="wallet-dropdown">
            <div className="wallet-dropdown-addr">
              <span className="field-label">Address</span>
              <code className="mono">{address}</code>
            </div>
            <div className="wallet-dropdown-info">
              <span className={networkReady ? "badge badge-green" : "badge badge-amber"}>
                {networkLabel}
              </span>
            </div>
            {networkMessage && <p className="wallet-dropdown-message">{networkMessage}</p>}
            {!networkReady && (
              <button className="btn btn-secondary btn-sm btn-full" onClick={onSwitchNetwork}>
                Switch to Hardhat 31337
              </button>
            )}
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
    </div>
  );
}
