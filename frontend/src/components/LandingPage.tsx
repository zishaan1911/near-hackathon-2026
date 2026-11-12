function EthereumCrystal() {
  return (
    <div className="crystal-stage" aria-hidden="true">
      <div className="orbit orbit-a" />
      <div className="orbit orbit-b" />
      <img className="eth-crystal" src="/logo.png" alt="" />
      <div className="float-card float-predict"><b>✦ Index</b><span>Compute prices in one number</span></div>
      <div className="float-card float-trade"><b>↗ Trade</b><span>Hourly futures on NEAR</span></div>
    </div>
  );
}

export function LandingPage({ onLaunch }: { onLaunch: () => void }) {
  return (
    <div className="landing-shell">
      <main className="hero">
        <section className="hero-copy">
          <div className="eyebrow"><span /> Compute derivatives</div>
          <h1>Trade the price of compute.<br /><em>Settled on NEAR.</em></h1>
          <p>The Congest Compute Index (CCI) tracks GPU rental, cloud capacity, AI inference and mining in one number, and settles on NEAR hourly in tUSDC (testnet).</p>
          <div className="hero-actions">
            <button className="button button-primary" onClick={onLaunch}>Launch App <span>→</span></button>
            <a className="button button-ghost" href="#how-it-works">Learn More</a>
          </div>
          <div className="hero-proof">
            <span><i className="status-dot" /> Live compute prices</span>
            <span>Compute Index (CCI)</span>
            <span>NEAR Protocol</span>
          </div>
        </section>
        <EthereumCrystal />
      </main>

      <section className="feature-row" id="how-it-works">
        <article><div className="feature-icon">✦</div><h3>One Index</h3><p>GPU rental, cloud capacity, AI inference and mining combined into the Congest Compute Index.</p></article>
        <article><div className="feature-icon">↗</div><h3>Trade on NEAR</h3><p>Low-cost hourly CCI futures with tUSDC collateral and settlement.</p></article>
        <article><div className="feature-icon">⇄</div><h3>Self-Custody Collateral</h3><p>Deposit and withdraw tUSDC from your own NEAR wallet, and claim settlements when a market ends.</p></article>
        <article><div className="feature-icon">⌁</div><h3>Hard Risk Controls</h3><p>Margin and order limits are enforced by the gateway and the contract.</p></article>
      </section>

      <footer className="app-footer">
        <span>© 2026 Congest · Compute futures on NEAR</span>
        <span>Trading on NEAR · tUSDC (testnet) collateral</span>
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
          Charts by TradingView
        </a>
      </footer>
    </div>
  );
}
