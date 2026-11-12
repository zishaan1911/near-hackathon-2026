// Must stay the first import: wallet-selector reads Buffer and process at load.
import '../polyfills';
import { NearProvider } from '../lib/near';
import Portfolio from '../pages/Portfolio';
import Trade from '../pages/Trade';
import { WalletButton } from './WalletButton';

/**
 * Everything that needs the wallet, loaded as one chunk for /trade and
 * /portfolio only. The provider stays mounted while moving between the two.
 */
export default function WalletApp({ route }: { route: 'trade' | 'portfolio' }) {
  return (
    <NearProvider>
      <WalletButton />
      {route === 'trade' ? <Trade /> : <Portfolio />}
    </NearProvider>
  );
}
