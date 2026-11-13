/**
 * Environment reads for the server. Variables are named SILICA_<NAME>; the
 * original GASX_<NAME> is still honoured as a fallback so deployments that
 * predate the rename keep working. SILICA_ wins when both are set.
 * (CRON_SECRET is unprefixed and read directly.)
 */

export type EnvSource = Record<string, string | undefined>;

export function readEnv(name: string, env: EnvSource = process.env): string | undefined {
  return env[`SILICA_${name}`] ?? env[`GASX_${name}`];
}