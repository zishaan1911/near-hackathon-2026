/** Environment reads for the adapter. Variables are named SILICA_<NAME>. */

export type EnvSource = Record<string, string | undefined>;

export function readEnv(name: string, env: EnvSource = process.env): string | undefined {
  return env[`SILICA_${name}`];
}
