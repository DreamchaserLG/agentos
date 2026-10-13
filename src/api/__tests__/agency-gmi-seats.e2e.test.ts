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
import { gmi } from '../gmi';
import { AgencyConfigError } from '../types';
import { buildSessionSeat, sessionSeat } from '../runtime/agencyLaunch/sessionSeat';
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

  it("a pre-built seat's description reaches the manager and its dependsOn orders the graph", async () => {
    // The manager of a hierarchical agency reads a pre-built seat's description into its roster.
    const k1 = key();
    const s1 = script('openai', k1, { replies: [reply.text('Nothing to delegate.')], whole: true });
    const checker = Object.assign(agent({ runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey: k1, instructions: 'Check.' }), {
      description: 'Checks facts against sources.',
    });
    const managed = agency({ provider: 'openai', model: 'stub-model', apiKey: k1, strategy: 'hierarchical', agents: { checker } });
    await managed.generate('Check the claim.');
    expect(systemText(s1.seen[0])).toContain('- checker: Checks facts against sources.');

    // A pre-built seat's dependsOn selects the graph strategy and orders the run: `b` waits for `a`, though the
    // roster lists `b` first, and receives `a`'s output as a dependency.
    const k2 = key();
    const s2 = script('openai', k2, { replies: [reply.text('Fact A.'), reply.text('Report B.')] });
    const seat = (instructions: string) => agent({ runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey: k2, instructions });
    const b = Object.assign(seat('Report.'), { dependsOn: ['a'] });
    const a = seat('Find a fact.');
    const graphTeam = agency({ provider: 'openai', model: 'stub-model', apiKey: k2, agents: { b, a } });
    const result = (await graphTeam.generate('Write the report.')) as { agentCalls: Array<{ agent: string; input: string }> };
    expect(result.agentCalls.map((call) => call.agent)).toEqual(['a', 'b']);
    expect(lastUserText(s2.seen[1])).toContain('Outputs from dependencies:');
    expect(lastUserText(s2.seen[1])).toContain('[a]:\nFact A.');
  });

  it('sessionSeat refuses a legacy agent and a tool the member lacks, and a seat whose id the member has open', async () => {
    const k = key();
    script('openai', k, { replies: [] });
    const legacy = agent({ provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'x' });
    expect(() => sessionSeat(legacy)).toThrow(TypeError);
    expect(() => sessionSeat(legacy)).toThrow('gmi() agent');
    const member = gmi({
      provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Tutor.',
      tools: { search: { description: 'Search.', parameters: { type: 'object', properties: {} }, execute: async () => 'hit' } },
    });
    expect(() => sessionSeat(member, { tools: ['send_email'] })).toThrow(TypeError);
    expect(() => sessionSeat(member, { tools: ['send_email'] })).toThrow("'send_email'");
    // The member serves a session under the id the seat would take: the seat's first call rejects, naming it.
    member.session('seat:lesson-1');
    const seat = sessionSeat(member, { sessionId: 'lesson-1' });
    await expect(seat.generate('Hi.')).rejects.toThrow(TypeError);
    await expect(seat.generate('Hi.')).rejects.toThrow("'seat:lesson-1'");
  });

  it('sessionSeat refuses the working-memory tools, which are memory tools', async () => {
    // The member keeps persistent notes through the package's two working-memory tools; nothing here reads or writes the file.
    const { MarkdownWorkingMemory } = await import('../../cognition/memory/core/working/MarkdownWorkingMemory');
    const { ReadWorkingMemoryTool } = await import('../../cognition/memory/core/working/ReadWorkingMemoryTool');
    const { UpdateWorkingMemoryTool } = await import('../../cognition/memory/core/working/UpdateWorkingMemoryTool');
    const notes = new MarkdownWorkingMemory('seat-notes.md');
    const member = gmi({
      provider: 'openai', model: 'stub-model', apiKey: key(), instructions: 'Keep notes.',
      tools: { read_working_memory: new ReadWorkingMemoryTool(notes), update_working_memory: new UpdateWorkingMemoryTool(notes) },
    });
    // The member has both tools, so each refusal names a memory tool, not a tool the member lacks.
    for (const name of ['read_working_memory', 'update_working_memory']) {
      expect(() => sessionSeat(member, { tools: [name] }), name).toThrow(TypeError);
      expect(() => sessionSeat(member, { tools: [name] }), name).toThrow(`'${name}' is a memory tool`);
    }
  });

  it('sessionSeat runs the member as itself, in one session for the run', async () => {
    const k = key();
    const s = script('openai', k, {
      replies: [
        reply.tools([{ id: 'd1', name: 'delegate_to_tutor', args: { task: 'Explain recursion.' } }]),
        reply.text('Recursion calls itself.'),
        reply.tools([{ id: 'd2', name: 'delegate_to_tutor', args: { task: 'Give an example.' } }]),
        reply.text('factorial(n) calls factorial(n - 1).'),
        reply.text('Done.'),
        reply.text('Hello again.'),
      ],
      whole: true,
    });
    const member = gmi({ provider: 'openai', model: 'stub-model', apiKey: k, name: 'Tutor', instructions: 'You are the tutor. Explain clearly.' });
    const seat = sessionSeat(member);
    const team = agency({ provider: 'openai', model: 'stub-model', apiKey: k, strategy: 'hierarchical', agents: { tutor: seat } });

    const result = (await team.generate('Teach recursion.')) as { text: string };
    expect(result.text).toBe('Done.');
    // The manager (agent()'s legacy path) asks for whole responses; the member's GMI streams.
    const tutorCalls = s.seen.filter((call) => call.streamed);
    expect(tutorCalls).toHaveLength(2);
    for (const call of tutorCalls) expect(systemText(call)).toContain('You are the tutor. Explain clearly.');
    // One session for the run: the second delegation's request holds the first exchange.
    const second = JSON.stringify(tutorCalls[1].messages);
    expect(second).toContain('Explain recursion.');
    expect(second).toContain('Recursion calls itself.');
    // The manager reads the member's own description.
    expect(systemText(s.seen[0])).toContain('- tutor: You are the tutor. Explain clearly.');

    await team.close();
    await expect(seat.generate('Again.')).rejects.toThrow('seat closed');
    // agency().close() closed the seat's session and left the member serving its own users.
    await expect(member.session('own').send('Hello?')).resolves.toMatchObject({ text: 'Hello again.' });
    // The seat session's tally went with it; the agent's tally holds its usage.
    expect((await member.usage(seat.seatId)).totalTokens).toBe(0);
    expect((await member.usage()).totalTokens).toBeGreaterThan(0);
  });
});
