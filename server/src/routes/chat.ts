/**
 * POST /api/v1/chat — a platform-explainer assistant backed by Groq.
 *
 * Why this lives server-side rather than the frontend calling Groq
 * directly: the API key must never reach the browser. Secrets never
 * go in client code, and a key embedded in a frontend bundle is trivially extractable by anyone
 * who opens devtools — it would not be "the server's key with extra
 * steps", it would be a public key. This route is the only thing that
 * ever sees SILICA_API_GROQ_API_KEY.
 *
 * The assistant is given the live Silica Compute Index (SCI) level and
 * its pillars as context on every request, from the shared compute
 * service (deps.getSci, best-effort). Without this, the model would either
 * refuse to answer "what's the SCI right now" or hallucinate a
 * plausible-sounding number.
 *
 * Conversation history is kept client-side and sent whole on every
 * request (this route is stateless), matching how every other route in
 * this gateway works — there is no session store to add.
 */
import type { FastifyInstance } from 'fastify';
import type { GatewayDeps } from '../server.js';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatBody {
  messages?: unknown;
}

const MAX_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 2000;

function validateMessages(body: ChatBody): ChatMessage[] | string {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return 'messages must be a non-empty array';
  }
  if (body.messages.length > MAX_MESSAGES) {
    return `messages must not exceed ${MAX_MESSAGES} entries`;
  }
  const validated: ChatMessage[] = [];
  for (const entry of body.messages) {
    const role = (entry as { role?: unknown } | null)?.role;
    if (typeof entry !== 'object' || entry === null || (role !== 'user' && role !== 'assistant')) {
      return "each message needs role 'user' or 'assistant'";
    }
    const content = (entry as { content?: unknown }).content;
    if (typeof content !== 'string' || !content.trim()) {
      return 'each message needs non-empty string content';
    }
    if (content.length > MAX_MESSAGE_LENGTH) {
      return `message content must not exceed ${MAX_MESSAGE_LENGTH} characters`;
    }
    validated.push({ role, content });
  }
  return validated;
}

/** Builds the system prompt: static platform description plus the live
 * Silica Compute Index (SCI) reading when available. Best-effort - a
 * failing compute service degrades this to "no live reading available"
 * rather than failing the whole chat request. */
async function buildSystemPrompt(deps: GatewayDeps): Promise<string> {
  const sci = await deps.getSci().catch(() => null);

  const lines = [
    'You are Kora, the assistant for Silica. Silica is a market for the price of ' +
      'compute. Silica publishes the Silica Compute Index (SCI) and lists ' +
      'an hourly SCI future (market SCI-1H) on NEAR.',
    '',
    'Key facts about the platform:',
    '- The SCI is a composite index of what compute costs right now, set to ' +
      '1000 at its base date. Above 1000 means compute is pricier than at ' +
      'the base date; below 1000 means cheaper.',
    '- It has six pillars: GPU rental (Vast.ai, RunPod, Akash), cloud GPU ' +
      'spot prices (AWS, Azure), cloud CPU spot prices (AWS, Azure), AI ' +
      'inference prices (OpenRouter), Bitcoin hashprice, and Ethereum ' +
      'blockspace (a 7-day median of base fees). Each pillar carries a ' +
      'weight; if a pillar is down, the remaining weights are rescaled and ' +
      'the index is flagged as degraded.',
    '- The hourly SCI future is a one-hour contract on the index level, ' +
      'settled in USDC on NEAR. An oracle account publishes the SCI level ' +
      'on-chain; when the hour ends the contract settles at the last ' +
      'published level and the next hourly market is rolled in. Buyers ' +
      'gain if the SCI settles higher than their entry price, sellers ' +
      'gain if it settles lower.',
    '- Order sizes and positions are capped by risk limits enforced in the ' +
      'gateway.',
    '- The quote and depth shown in the order book are indicative; real ' +
      'depth comes from open orders on the NEAR contract.',
    '',
  ];

  if (sci && sci.index.level !== null) {
    const pillars = sci.components
      .map((c) => `${c.label}: ${c.status === 'ok' && c.level !== null ? Math.round(c.level) : 'down'}`)
      .join('; ');
    lines.push(
      `Current live reading: SCI = ${Math.round(sci.index.level)} (base ${sci.index.base}), ` +
        `as of ${sci.index.asOf}${sci.index.degraded ? ', degraded (some pillars are down)' : ''}.`,
      `Pillar levels (1000 = base): ${pillars}.`,
    );
  } else {
    lines.push('No live SCI reading is available right now -- say so rather than guessing a number.');
  }

  lines.push(
    '',
    'Answer questions about the platform and these current stats plainly ' +
      'and concisely. If asked about a live number you were not given ' +
      'above, say you do not have that reading rather than inventing one. ' +
      'You are not a financial advisor; do not give trading advice or tell ' +
      'anyone what to buy or sell.',
  );

  return lines.join('\n');
}
export function registerChatRoutes(app: FastifyInstance, deps: GatewayDeps): void {
  app.post<{ Body: ChatBody }>('/api/v1/chat', async (request, reply) => {
    if (!deps.groq?.apiKey) {
      return reply.status(501).send({
        error: 'chat assistant not configured -- set SILICA_API_GROQ_API_KEY (see .env.example)',
      });
    }

    const messages = validateMessages(request.body ?? {});
    if (typeof messages === 'string') {
      return reply.status(400).send({ error: messages });
    }

    const systemPrompt = await buildSystemPrompt(deps);

    let groqResponse: Response;
    try {
      groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${deps.groq.apiKey}`,
        },
        body: JSON.stringify({
          model: deps.groq.model,
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
          temperature: 0.3,
          max_tokens: 500,
        }),
      });
    } catch (err) {
      return reply.status(502).send({ error: `could not reach Groq: ${(err as Error).message}` });
    }

    if (!groqResponse.ok) {
      const body = await groqResponse.text().catch(() => '');
      return reply.status(502).send({
        error: `Groq returned ${groqResponse.status}: ${body.slice(0, 300)}`,
      });
    }

    const payload = (await groqResponse.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const reply_ = payload.choices?.[0]?.message?.content;
    if (typeof reply_ !== 'string') {
      return reply.status(502).send({ error: 'Groq response did not include a message' });
    }

    return { reply: reply_ };
  });
}

