/**
 * @file key-pool-recheck-breaker.e2e.test.ts
 * A pool whose keys were all refused gets them back at their recheck without the provider health breaker opening
 * again: the pool probes a failed key `recheckMs` after its failure (not at the next tick of an interval fixed when the
 * provider started), and the call that half-closes the breaker is served by the key the probe brought back. A dead
 * pool holds the breaker open no longer than the soonest recheck, so a call that comes shortly before it does not keep
 * the provider out past the probe. Drives generateText through the real resolver, provider manager, AnthropicProvider
 * and health registry, with fake timers; only fetch is stubbed, answering by the key a request carries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { generateText } from '../generateText.js';
import { shutdownProviderManagers } from '../model.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';

const K0 = 'sk-ant-recheck-alpha-0000';
const K1 = 'sk-ant-recheck-beta-1111';
const MINUTE = 60_000;

/** The keys the stubbed API refuses with its 401 envelope. */
const refused = new Set<string>();
/** The keys whose organization has no credit: a message answers the credit-balance 400. */
const noCredit = new Set<string>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** One `data:` line per event. */
function sse(events: unknown[]): Response {
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const served = () =>
  sse([
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Served.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]);

/** The key a request carried in its x-api-key header. */
const keyOf = (init?: RequestInit) => new Headers(init?.headers).get('x-api-key') ?? '';

/** Whether a message is a request's (streamed) or a billing probe's (one token, not streamed). */
const streamed = (init?: RequestInit) => {
  try {
    return (JSON.parse(String(init?.body ?? '{}')) as { stream?: unknown }).stream === true;
  } catch {
    return false;
  }
};

/** Each request in call order: a probe (the models list, or a one-token message) or a request (a message), and its key. */
const sent = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    kind: String(url).includes('/v1/models') || !streamed(init as RequestInit) ? 'probe' : 'request',
    key: keyOf(init as RequestInit),
  }));

const creditBalanceTooLow = () =>
  json(
    {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
      },
    },
    400,
  );

const ask = () => generateText({ provider: 'anthropic', model: 'claude-opus-5-5', prompt: 'Hello?', fallbackProviders: [] });

const savedOpenRouterKey = process.env.OPENROUTER_API_KEY;

describe('a pool whose keys were refused, at their recheck', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
    fetchMock.mockReset();
    refused.clear();
    noCredit.clear();
    globalLLMProviderHealth.reset();
    vi.stubEnv('ANTHROPIC_API_KEY', `${K0},${K1}`);
    vi.stubEnv('AGENTOS_KEY_POOL_STRATEGY_ANTHROPIC', 'ordered');
    // Without the Anthropic key the resolver would reroute to OpenRouter; keep it out.
    delete process.env.OPENROUTER_API_KEY;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      if (refused.has(keyOf(init))) return json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401);
      if (String(url).includes('/v1/models')) return json({ data: [], has_more: false, first_id: null, last_id: null });
      if (String(url).includes('/v1/messages') && noCredit.has(keyOf(init))) return creditBalanceTooLow();
      if (String(url).includes('/v1/messages')) return served();
      throw new Error(`unexpected request ${String(url)}`);
    });
  });

  afterEach(async () => {
    await shutdownProviderManagers();
    globalLLMProviderHealth.reset();
    vi.unstubAllEnvs();
    if (savedOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('probes the keys at the recheck and serves the call that half-closes the breaker, which stays closed', async () => {
    // The provider starts at T=0 and serves.
    expect((await ask()).text).toBe('Served.');

    // At T=10 both keys are refused (a key rotation at the console): the call hops from K0 to K1, every key is out,
    // and the 401 opens the auth breaker until T=40, the keys' recheck.
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    refused.add(K0);
    refused.add(K1);
    await expect(ask()).rejects.toMatchObject({ code: 'ALL_KEYS_FAILED', httpStatus: 401 });
    expect(globalLLMProviderHealth.getStats('anthropic')).toMatchObject({ state: 'open', totalTrips: 1 });

    // The keys are restored at T=20. At T=40 the pool probes both and takes them back.
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    refused.clear();
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(sent().filter((s) => s.kind === 'probe').map((s) => s.key)).toEqual([K0, K1]);

    // The call at T=40 half-closes the breaker and is served by K0; the breaker does not open again.
    expect((await ask()).text).toBe('Served.');
    const requests = sent().filter((s) => s.kind === 'request');
    expect(requests.map((s) => s.key)).toEqual([K0, K0, K1, K0]);
    expect(globalLLMProviderHealth.getStats('anthropic')).toMatchObject({ state: 'closed', totalTrips: 1 });
    expect(globalLLMProviderHealth.isOpen('anthropic')).toBe(false);
  });

  it("opens the breaker no longer than the keys' recheck, so a call a second before it does not hold the provider past the probe", async () => {
    // The provider starts at T=0 and serves.
    expect((await ask()).text).toBe('Served.');

    // At T=10 both organizations run out of credit: the call hops from K0 to K1, every key is out until its recheck at
    // T=40, and the credit-balance 400 opens the breaker's billing class for its 5 minutes.
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    noCredit.add(K0);
    noCredit.add(K1);
    await expect(ask()).rejects.toMatchObject({ code: 'ALL_KEYS_FAILED', httpStatus: 400 });
    expect(globalLLMProviderHealth.getStats('anthropic')).toMatchObject({ state: 'open', totalTrips: 1 });

    // Credit is bought at T=20. Traffic is sparse: the next call comes at T=39:59, a second before the recheck. The
    // breaker has half-closed, no key is due and no probe runs, so the provider throws ALL_KEYS_FAILED without a
    // request, the keys a second from their recheck; the breaker opens for that second, not for another 5 minutes.
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    noCredit.clear();
    await vi.advanceTimersByTimeAsync(20 * MINUTE - 1000);
    await expect(ask()).rejects.toMatchObject({ code: 'ALL_KEYS_FAILED', httpStatus: 402, details: { kinds: ['billing'], retryAfterMs: 1000 } });
    expect(globalLLMProviderHealth.getStats('anthropic')).toMatchObject({ state: 'open', totalTrips: 2, cooldownRemainingMs: 1000 });

    // At T=40 the pool probes both keys with a one-token message and takes them back; the call a second later passes
    // the breaker and is served by K0.
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent().filter((s) => s.kind === 'probe').map((s) => s.key)).toEqual([K0, K1]);
    expect((await ask()).text).toBe('Served.');
    expect(sent().filter((s) => s.kind === 'request').map((s) => s.key)).toEqual([K0, K0, K1, K0]);
    expect(globalLLMProviderHealth.isOpen('anthropic')).toBe(false);
  });
});
