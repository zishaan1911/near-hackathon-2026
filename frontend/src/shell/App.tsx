import { lazy, Suspense, useEffect } from 'react';
import { needsWallet, PATHS, type RouteId } from '../lib/routes';
import Home from '../pages/Home';
import { Skeleton } from '../ui/bits';
import { Link, useRoute } from '../ui/router';
import { Shell } from './Shell';

// The index page and the wallet routes load on demand, so the first load of
// "/" carries neither the charts nor the ~2 MB of wallet code.
const IndexPage = lazy(() => import('../pages/IndexPage'));
const WalletApp = lazy(() => import('../wallet/WalletApp'));

const TITLES: Record<RouteId, string> = {
  home: 'Silica: trade the price of compute',
  index: 'Silica Compute Index',
  trade: 'Trade · Silica',
  portfolio: 'Portfolio · Silica',
  notFound: 'Not found · Silica',
};

function PageLoading() {
  return (
    <section className="wrap page-head">
      <Skeleton className="skel-big" label="Loading" />
    </section>
  );
}

function NotFound() {
  return (
    <section className="wrap page-head">
      <h1 className="title">Nothing here.</h1>
      <p className="actions">
        <Link to={PATHS.home} className="btn">
          Go home
        </Link>
      </p>
    </section>
  );
}

function Page({ route }: { route: RouteId }) {
  if (route === 'home') return <Home />;
  if (route === 'index') return <IndexPage />;
  if (needsWallet(route)) return <WalletApp route={route === 'trade' ? 'trade' : 'portfolio'} />;
  return <NotFound />;
}

export function App() {
  const route = useRoute();

  useEffect(() => {
    document.title = TITLES[route];
  }, [route]);

  return (
    <Shell route={route}>
      <Suspense fallback={<PageLoading />}>
        <Page route={route} />
      </Suspense>
    </Shell>
  );
}
