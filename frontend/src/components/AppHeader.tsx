import { NEAR_NETWORK, useNear } from '../lib/near';
import { Brand } from './Brand';
import { useTheme } from '../theme';

// Section ids on the single, unified Markets page (App.tsx). These are no
// longer separate views to switch between -- clicking one just scrolls
// the already-rendered section into view.
export const MARKET_SECTIONS = [
  { id: 'section-overview', label: 'Overview' },
  { id: 'section-trade', label: 'Trade' },
  { id: 'section-analytics', label: 'Analytics' },
] as const;

function shortAccountId(accountId: string) {
  return accountId.length > 18 ? `${accountId.slice(0, 8)}…${accountId.slice(-8)}` : accountId;
}

function networkLabel(network: string) {
  return network.replace(/^./, (character) => character.toUpperCase());
}

export function AppHeader({
  onMarkets,
  onHome,
}: {
  /** Ensures the single Markets page is showing, then scrolls to it.
   * Called both by "Markets" itself and, with a target section, by
   * each of the in-page shortcuts. */
  onMarkets: (sectionId?: string) => void;
  onHome: () => void;
}) {
  const { accountId, ready, connect, disconnect } = useNear();
  const { theme, toggle } = useTheme();

  const walletConnected = accountId !== null;

  const statusText = walletConnected
    ? 'wallet connected'
    : ready
      ? 'configured'
      : 'loading wallet';

  async function disconnectWallet() {
    try {
      await disconnect();
    } catch (error) {
      console.error('Wallet disconnect failed', error);
    }
  }

  return (
    <header className="app-header">
      <button className="brand-button" onClick={onHome}>
        <Brand />
      </button>

      <nav className="app-nav">
        {/* Explicit Home entry -- previously only reachable by clicking the
            brand mark, which is a common but not especially discoverable
            pattern. Kept the brand-click behaviour too; this just adds a
            labelled way to do the same thing. */}
        <button onClick={onHome}>Home</button>

        {/* These buttons jump to a section of the single Markets page
            rather than switching what is rendered. */}
        {MARKET_SECTIONS.map((section) => (
          <button key={section.id} onClick={() => onMarkets(section.id)}>
            {section.label}
          </button>
        ))}
      </nav>

      <div className="header-actions">
        <button
          className="theme-toggle"
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={toggle}
          aria-label="Toggle theme"
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>

        <div
          className={`network-pill ${walletConnected ? 'wallet-connected' : 'wallet-disconnected'}`}
          title={`Selected NEAR network: ${NEAR_NETWORK}. ${walletConnected ? 'A wallet is connected.' : 'No browser wallet is connected.'}`}
        >
          <i />
          <span>NEAR {networkLabel(NEAR_NETWORK)}</span>
          <small className="network-state">{statusText}</small>
        </div>

        {walletConnected && accountId ? (
          <div className="account-pill">
            <span>◉</span>
            {shortAccountId(accountId)}
            <button title="Disconnect wallet" onClick={() => void disconnectWallet()}>
              ×
            </button>
          </div>
        ) : (
          <button
            className="button button-small button-primary"
            onClick={connect}
            disabled={!ready}
          >
            Connect Wallet
          </button>
        )}
      </div>
    </header>
  );
}
