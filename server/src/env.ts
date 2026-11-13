/**
 * Environment reads for the server. Variables are named SILICA_<NAME>.
 * (CRON_SECRET is unprefixed and read directly.)
 */

export type EnvSource = Record<string, string | undefined>;

export function readEnv(name: string, env: EnvSource = process.env): string | undefined {
  return env[`SILICA_${name}`];
}