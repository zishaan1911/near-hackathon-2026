/**
 * Local entrypoint: loads .env files, builds the app and starts
 * listening. On Vercel the same app is served by src/vercelHandler.ts (bundled to api/index.js).
 * Run with:
 *
 *   cd server && npm run dev
 */
import { loadEnvFile } from 'node:process';
import { buildApp } from './app.js';
import { readEnv } from './env.js';

// Load the gateway's own .env plus the NEAR adapter's .env file
// (server/.env.example documents the split). Each is optional — config
// defaults and the adapter's own validation still apply afterwards.
for (const path of ['.env', '../blockchain/near/.env']) {
  try {
    loadEnvFile(path);
  } catch {
    // No .env file at this path — variables may come from the shell.
  }
}

const app = buildApp();
const port = Number.parseInt(readEnv('API_PORT') ?? '3000', 10);

app
  .listen({ port, host: '0.0.0.0' })
  .then(() => app.log.info(`Silica API server listening on :${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
