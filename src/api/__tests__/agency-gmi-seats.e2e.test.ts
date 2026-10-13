/**
 * agency() with GMI seats, end to end: the agency-level runtime, seat metadata on pre-built seats, and
 * sessionSeat(), which seats a persistent gmi() agent as itself. The real agency(), its strategies, agent(),
 * gmi(), provider manager, completion gateway, GMI and tool orchestrator run; only the provider classes are
 * stubbed (helpers/stubProviders.ts), at their module boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import { agency } from '../agency';
import { agent } from '../agent';
import { AgencyConfigError } from '../types';
import { reply, script } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

let n = 0;
const key = () => `k-seats-${++n}`;
/** The system prompt a model call sent: the text of its system messages. */
const systemText = (call: { messages: Array<{ role: string; content: unknown }> }): string =>
  call.messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
/** The text of a model call's last user message. */
const lastUserText = (call: { messages: Array<{ role: string; content: unknown }> }): string => {
  const users = call.messages.filter((m) => m.role === 'user');
  const last = users[users.length - 1];
  return last ? (typeof last.content === 'string' ? last.content : JSON.stringify(last.content)) : '';
};

beforeEach(() => globalLLMProviderHealth.reset());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('agency() seats served by GMIs', () => {
  it("agency({ runtime: 'gmi' }) serves every config seat with a GMI, and a seat's runtime: 'legacy' wins", async () => {
    const k = key();
    // `whole` lets agent()'s legacy path ask for a whole response; a GMI streams every call.
    const s = script('openai', k, { replies: [reply.text('Notes.'), reply.text('Summary.')], whole: true });
    const team = agency({
      provider: 'openai',
      model: 'stub-model',
      apiKey: k,
      strategy: 'sequential',
      runtime: 'gmi',
      agents: {
        researcher: { instructions: 'Research.' },
        writer: { runtime: 'legacy', instructions: 'Write.' },
      },
    });

    const result = (await team.generate('Find sources.')) as { text: string };
    expect(result.text).toBe('Summary.');
    expect(s.seen.map((call) => call.streamed)).toEqual([true, false]);
    expect(systemText(s.seen[0])).toContain('Research.');

    expect(() => agency({ provider: 'openai', model: 'stub-model', apiKey: k, runtime: 'fast' as 'gmi', agents: { a: { instructions: 'x' } } })).toThrow(AgencyConfigError);
  });
});
