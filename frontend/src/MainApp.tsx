// The trading app and its wallet libraries, in their own chunk so that
// /compute does not download them. polyfills must load before the wallet code.
import './polyfills';
import App from './App';
import { ThemeProvider } from './theme';
import { NearProvider } from './lib/near';

export default function MainApp() {
  return (
    <ThemeProvider>
      <NearProvider>
        <App />
      </NearProvider>
    </ThemeProvider>
  );
}
