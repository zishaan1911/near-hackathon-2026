/**
 * Local entrypoint: loads .env files, builds the app and starts
 * listening. On Vercel the same app is served by api/index.ts instead.
 * Run with:
 *
 *   cd server && npm run dev
 */
import { loadEnvFile } from 'node:process';
import { buildApp } from './app.js';

// Load the gateway's own .env plus the NEAR adapter's .env file
// (api/.env.example documents the split). Each is optional — config
// defaults and the adapter's own validation still apply afterwards.
for (const path of ['.env', '../blockchain/near/.env']) {
  try {
    loadEnvFile(path);
  } catch {
    // No .env file at this path — variables may come from the shell.
  }
}

const app = buildApp();
const port = Number.parseInt(process.env.GASX_API_PORT ?? '3000', 10);

app
  .listen({ port, host: '0.0.0.0' })
  .then(() => app.log.info(`GASX API gateway listening on :${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
