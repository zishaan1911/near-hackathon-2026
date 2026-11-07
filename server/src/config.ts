/**
 * Environment-driven configuration for the API gateway. Copy .env.example
 * to .env and fill in real values.
 */
import { loadConfigFromEnv as loadNearConfig, type NearAdapterConfig } from '@gasx/near-adapter';
import type { RiskPolicyConfig } from './riskPolicy.js';

export interface GatewayConfig {
  port: number;
  /** Base URL of the Python AI service (ai/main.py's FastAPI app), e.g.
   * http://localhost:8000. */
  aiServiceUrl: string;
  /** MySQL connection URL. Undefined disables persistence entirely —
   * the gateway then runs without durable state (see src/db.ts). */
  databaseUrl: string | undefined;
  near: NearAdapterConfig;
  riskPolicy: RiskPolicyConfig;
  /** Undefined disables the chat assistant entirely -- POST
   * /api/v1/chat then returns 501 rather than silently degrading, since
   * a chatbot that cannot reach an LLM is not a smaller chatbot, it is
   * no chatbot. Never sent to the client; the key stays server-side. */
  groq: { apiKey: string | undefined; model: string };
}

function readEnv(name: string): string | undefined {
  return typeof process !== 'undefined' ? process.env[name] : undefined;
}

function readEnvInt(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be an integer, got '${raw}'`);
  }
  return n;
}

/** Loads the gateway's own settings plus the NEAR adapter's config (it
 * validates its own required variables — see its .env.example) from
 * GASX_API_-prefixed (gateway) and adapter-specific environment
 * variables. */
export function loadGatewayConfig(): GatewayConfig {
  return {
    port: readEnvInt('GASX_API_PORT', 3000),
    // On Vercel the AI service is the Python function at /api/ai on the
    // same deployment (api/ai.py).
    aiServiceUrl:
      readEnv('GASX_API_AI_SERVICE_URL') ||
      (readEnv('VERCEL_URL') ? `https://${readEnv('VERCEL_URL')}/api/ai` : 'http://localhost:8000'),
    databaseUrl: readEnv('GASX_API_DATABASE_URL') || undefined,
    near: loadNearConfig(),
    riskPolicy: {
      // ARCHITECTURE.md §8's defaults — "small fixed cap" left concrete
      // here rather than symbolic; override via env for a different
      // demo budget.
      maxOrderContracts: readEnvInt('GASX_API_MAX_ORDER_CONTRACTS', 100),
      maxPositionContracts: readEnvInt('GASX_API_MAX_POSITION_CONTRACTS', 500),
      // Disabled by default (0 skips the check entirely -- see
      // riskPolicy.ts's checkOrderRisk). This removes a real protection
      // against placing an order far from the oracle price; the
      // deliberate tradeoff is frictionless testnet trading over
      // guarding against unfavourable pricing. Set a positive value
      // (e.g. 100 = 1%) to re-enable it.
      maxSlippageBps: readEnvInt('GASX_API_MAX_SLIPPAGE_BPS', 0),
      minModelConfidence: readEnvInt('GASX_API_MIN_MODEL_CONFIDENCE_PCT', 70) / 100,
      maxHedgeNotional: readEnvInt('GASX_API_MAX_HEDGE_NOTIONAL', 1000),
    },
    groq: {
      apiKey: readEnv('GASX_API_GROQ_API_KEY') || undefined,
      // llama-3.3-70b-versatile, the model most existing Groq examples
      // still show, was deprecated (2026-07) in favour of the
      // openai/gpt-oss family -- verified against Groq's own current
      // docs rather than assumed, since this is exactly the kind of
      // detail that goes stale fast. gpt-oss-20b over -120b for a
      // chat-widget assistant: faster and cheaper, and this task
      // (explaining the platform, reading back numbers it is handed)
      // does not need the larger model's extra capability.
      model: readEnv('GASX_API_GROQ_MODEL') || 'openai/gpt-oss-20b',
    },
  };
}
