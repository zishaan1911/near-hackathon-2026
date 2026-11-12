import { createContext, useState, type ReactNode } from 'react';
import { needsWallet, PATHS, type RouteId } from '../lib/routes';
import { Logo } from '../ui/Logo';
import { Link } from '../ui/router';
import { Ask } from './Ask';

/**
 * Where the nav's right-hand button goes. The wallet chunk portals its button
 * in here, so the shell itself never imports wallet code.
 */
export const NavSlotContext = createContext<HTMLElement | null>(null);

const LINKS: ReadonlyArray<{ route: RouteId; to: string; label: string }> = [
  { route: 'index', to: PATHS.index, label: 'Index' },
  { route: 'trade', to: PATHS.trade, label: 'Trade' },
  { route: 'portfolio', to: PATHS.portfolio, label: 'Portfolio' },
];

export function Shell({ route, children }: { route: RouteId; children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const wallet = needsWallet(route);

  return (
    <NavSlotContext.Provider value={slot}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="nav">
        <div className="wrap nav-row">
          <Link to={PATHS.home} className="nav-home" aria-label="Silica home">
            <Logo />
          </Link>
          <nav className="nav-links" aria-label="Main">
            {LINKS.map((link) => (
              <Link
                key={link.route}
                to={link.to}
                aria-current={route === link.route ? 'page' : undefined}
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="nav-action">
            {!wallet && (
              <Link to={PATHS.trade} className="btn btn-sm">
                Start trading
              </Link>
            )}
            <span ref={setSlot} className={wallet ? 'nav-slot nav-slot-wallet' : 'nav-slot'} />
          </div>
        </div>
      </header>

      <main id="main">{children}</main>

      <footer className="footer">
        <div className="wrap footer-row">
          <p>Silica runs on NEAR testnet. Test tokens have no value.</p>
          <p className="footer-links">
            <Link to={`${PATHS.index}#method`}>Methodology</Link>
            <Link to={`${PATHS.index}#credits`}>Image credits</Link>
            <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
              Charts by TradingView
            </a>
          </p>
        </div>
      </footer>

      <Ask hideOnPhone={route === 'trade'} />
    </NavSlotContext.Provider>
  );
}
