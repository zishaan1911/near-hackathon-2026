function EthereumCrystal() {
  return (
    <div className="crystal-stage" aria-hidden="true">
      <div className="orbit orbit-a" />
      <div className="orbit orbit-b" />
      <img className="eth-crystal" src="/logo.png" alt="" />
      <div className="float-card float-predict"><b>✦ Predict</b><span>AI-powered forecasts</span></div>
      <div className="float-card float-trade"><b>↗ Trade</b><span>Gas futures on NEAR</span></div>
    </div>
  );
}

export function LandingPage({ onLaunch }: { onLaunch: () => void }) {
  return (
    <div className="landing-shell">
      <main className="hero">
        <section className="hero-copy">
          <div className="eyebrow"><span /> AI-native gas derivatives</div>
          <h1>Trade Ethereum gas congestion.<br /><em>Settled on NEAR.</em></h1>
          <p>Congest is built on EGSI, the Ethereum Gas Stress Index (0–1000), and every position settles after one hour, collateralised in tUSDC (testnet).</p>
          <div className="hero-actions">
            <button className="button button-primary" onClick={onLaunch}>Launch App <span>→</span></button>
            <a className="button button-ghost" href="#how-it-works">Learn More</a>
          </div>
          <div className="hero-proof">
            <span><i className="status-dot" /> Live Ethereum data</span>
            <span>EGSI 0–1000</span>
            <span>NEAR Protocol</span>
          </div>
        </section>
        <EthereumCrystal />
      </main>

      <section className="feature-row" id="how-it-works">
        <article><div className="feature-icon">✦</div><h3>AI-Powered</h3><p>Real-time EGSI and confidence-scored congestion forecasts.</p></article>
        <article><div className="feature-icon">↗</div><h3>Trade on NEAR</h3><p>Low-cost EGSI-1H futures with tUSDC collateral and settlement.</p></article>
        <article><div className="feature-icon">⇄</div><h3>Self-Custody Collateral</h3><p>Deposit and withdraw tUSDC from your own NEAR wallet, and claim settlements when a market ends.</p></article>
        <article><div className="feature-icon">⌁</div><h3>Hard Risk Controls</h3><p>The AI can request actions, but it cannot bypass configured limits.</p></article>
      </section>

      <footer className="app-footer">
        <span>© 2026 Congest · AI-native Ethereum gas futures</span>
        <span>Trading on NEAR · tUSDC (testnet) collateral</span>
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
          Charts by TradingView
        </a>
      </footer>
    </div>
  );
}
