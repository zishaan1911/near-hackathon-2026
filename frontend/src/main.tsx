import './polyfills';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ThemeProvider } from './theme';
import { NearProvider } from './lib/near';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <NearProvider>
        <App />
      </NearProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
