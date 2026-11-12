import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer, type GatewayDeps } from '../src/server.js';
import type { RiskPolicyConfig } from '../src/riskPolicy.js';
import type { CciResponse } from '../src/compute/service.js';
import { FakeChainAdapter, makeCciResponse } from './fakes.js';

const riskPolicy: RiskPolicyConfig = {
  maxOrderContracts: 100,
  maxPositionContracts: 500,
  maxSlippageBps: 100,
};

let app: FastifyInstance;
let getCci: () => Promise<CciResponse>;
let fetchMock: ReturnType<typeof vi.fn>;

function buildApp(groq?: { apiKey: string | undefined; model: string }) {
  const deps: GatewayDeps = {
    chainAdapter: new FakeChainAdapter(),
    getCci: () => getCci(),
    riskPolicy,
    logger: false,
    groq,
  };
  return buildServer(deps);
}

function groqSuccess(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => '',
  } as Response;
}

beforeEach(() => {
  getCci = async () => makeCciResponse(1042.6);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/v1/chat', () => {
  it('returns 501 when no Groq API key is configured', async () => {
    app = buildApp(undefined);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toMatch(/GASX_API_GROQ_API_KEY/);
    // No API key configured means it must never even try to reach Groq.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty messages array', async () => {
    app = buildApp({ apiKey: 'test-key', model: 'openai/gpt-oss-20b' });
    const res = await app.inject({ method: 'POST', url: '/api/v1/chat', payload: { messages: [] } });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for a message with an invalid role', async () => {
    app = buildApp({ apiKey: 'test-key', model: 'openai/gpt-oss-20b' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: { messages: [{ role: 'system', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for empty content', async () => {
    app = buildApp({ apiKey: 'test-key', model: 'openai/gpt-oss-20b' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: { messages: [{ role: 'user', content: '   ' }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 beyond the message count cap', async () => {
    app = buildApp({ apiKey: 'test-key', model: 'openai/gpt-oss-20b' });
    const messages = Array.from({ length: 21 }, () => ({ role: 'user', content: 'hi' }));
    const res = await app.inject({ method: 'POST', url: '/api/v1/chat', payload: { messages } });
    expect(res.statusCode).toBe(400);
  });

  it('forwards to Groq with the configured model and returns the reply', async () => {
    app = buildApp({ apiKey: 'test-key', model: 'openai/gpt-oss-20b' });
    fetchMock.mockResolvedValue(groqSuccess('Congest lists an hourly compute index future.'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: { messages: [{ role: 'user', content: 'What is Congest?' }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().reply).toBe('Congest lists an hourly compute index future.');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(init.headers.authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('openai/gpt-oss-20b');
  });

  it('never sends the API key to the response body', async () => {
    app = buildApp({ apiKey: 'super-secret-key', model: 'openai/gpt-oss-20b' });
    fetchMock.mockResolvedValue(groqSuccess('hello'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });

    expect(JSON.stringify(res.json())).not.toContain('super-secret-key');
  });

  it('includes the live CCI reading and pillars in the system prompt when available', async () => {
    app = buildApp({ apiKey: 'test-key', model: 'openai/gpt-oss-20b' });
    fetchMock.mockResolvedValue(groqSuccess('ok'));

    await app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: { messages: [{ role: 'user', content: 'What is the current CCI?' }] },
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body);
    const systemMessage = body.messages[0].content as string;
    expect(systemMessage).toMatch(/CCI = 1043/);
    expect(systemMessage).toMatch(/GPU rental: 1040/);
    expect(systemMessage).toMatch(/Ethereum blockspace: down/);
    expect(systemMessage).not.toMatch(/EGSI|gas futures/i);
    expect(systemMessage).toMatch(/not a financial advisor/);
  });

  it('tells the model plainly when no live reading exists, rather than omitting the topic', async () => {
    app = buildApp({ apiKey: 'test-key', model: 'openai/gpt-oss-20b' });
    getCci = async () => makeCciResponse(null);
    fetchMock.mockResolvedValue(groqSuccess('ok'));

    await app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const systemMessage = JSON.parse(init.body).messages[0].content as string;
    expect(systemMessage).toMatch(/No live CCI reading is available/);
  });

  it('returns 502 when Groq itself errors, with the status surfaced', async () => {
    app = buildApp({ apiKey: 'test-key', model: 'openai/gpt-oss-20b' });
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
      json: async () => ({}),
    } as Response);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/429/);
  });

  it('returns 502 when the network call itself fails', async () => {
    app = buildApp({ apiKey: 'test-key', model: 'openai/gpt-oss-20b' });
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });

    expect(res.statusCode).toBe(502);
  });

  it('does not fail the whole request when the compute service throws for context', async () => {
    app = buildApp({ apiKey: 'test-key', model: 'openai/gpt-oss-20b' });
    getCci = async () => {
      throw new Error('compute down');
    };
    fetchMock.mockResolvedValue(groqSuccess('ok'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });

    expect(res.statusCode).toBe(200);
  });
});

