import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';

// Separate chunks: each route downloads only what it renders.
const ComputeExperience = lazy(() => import('./compute/ComputeExperience'));
const MainApp = lazy(() => import('./MainApp'));

const isComputeRoute = window.location.pathname.startsWith('/compute');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Suspense fallback={<div style={{ minHeight: '100vh', background: '#050507' }} />}>
      {isComputeRoute ? <ComputeExperience /> : <MainApp />}
    </Suspense>
  </React.StrictMode>,
);
