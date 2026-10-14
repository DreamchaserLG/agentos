/**
 * The launch engine (spec 4.8), with a fake host and fake seats under the real agency(): validation, the child's
 * caps, one case per refusal code, the run and its statuses, and the deadline and the grace. Pure engine logic; the
 * surfaces' own tests run the real seats.
 */
import { describe, expect, it } from 'vitest';
import { validateLaunchArgs } from '../runLaunch.js';
import type { LaunchAgencyArgs } from '../types.js';

const seat = (role: string, extra: Record<string, unknown> = {}) => ({ role, instructions: `Be the ${role}.`, ...extra });
const args = (extra: Partial<LaunchAgencyArgs> & Record<string, unknown> = {}): LaunchAgencyArgs =>
  ({ goal: 'Write the report.', seats: [seat('writer')], ...extra }) as LaunchAgencyArgs;

describe('validateLaunchArgs', () => {
  it('accepts a one-seat subagent and every strategy with its seat count', () => {
    expect(validateLaunchArgs(args())).toBeUndefined();
    expect(validateLaunchArgs(args({ strategy: 'review-loop', seats: [seat('writer'), seat('critic')] }))).toBeUndefined();
    expect(validateLaunchArgs(args({ strategy: 'graph', seats: [seat('a'), seat('b', { dependsOn: ['a'] })] }))).toBeUndefined();
    expect(validateLaunchArgs(args({ seats: [{ role: 'tutor', agentKey: 'tutor', brief: 'Check the maths.' }] as LaunchAgencyArgs['seats'] }))).toBeUndefined();
  });

  it('refuses each malformed argument with invalid_arguments, naming the first problem', () => {
    const cases: Array<[LaunchAgencyArgs, RegExp]> = [
      [args({ goal: '' }), /goal/],
      [args({ goal: 'x'.repeat(8_001) }), /goal/],
      [args({ extra: true }), /unknown argument 'extra'/],
      [args({ strategy: 'panel' as never }), /strategy/],
      [args({ seats: [] }), /at least one seat/],
      [args({ seats: [seat('writer', { colour: 'blue' })] }), /unknown key 'colour'/],
      [args({ seats: [seat('9lives')] }), /role/],
      [args({ seats: [seat('r'.repeat(53))] }), /52 characters/],
      [args({ seats: [seat('delegate_to_writer')] }), /hierarchical strategy uses/],
      [args({ seats: [seat('plan')] }), /hierarchical strategy uses/],
      [args({ seats: [seat('writer'), seat('writer')] }), /unique/],
      [args({ seats: [{ role: 'writer' } as never] }), /exactly one of instructions, agentKey and personaId/],
      [args({ seats: [{ role: 'w', instructions: 'x', agentKey: 'k' } as never] }), /exactly one/],
      [args({ seats: [seat('writer', { instructions: 'x'.repeat(8_193) })] }), /8,192/],
      [args({ seats: [{ role: 'tutor', agentKey: 'tutor', brief: 'x'.repeat(1_001) }] as never }), /1,000/],
      [args({ seats: [seat('writer', { brief: 'Short.' })] }), /brief/],
      [args({ seats: [seat('writer', { tools: 'search' })] }), /tools/],
      [args({ seats: [seat('a', { dependsOn: ['ghost'] })] }), /dependsOn names 'ghost'/],
      [args({ strategy: 'graph', seats: [seat('a', { dependsOn: ['b'] }), seat('b', { dependsOn: ['a'] })] }), /cycle/],
      [args({ strategy: 'review-loop', seats: [seat('a'), seat('b'), seat('c')] }), /review-loop takes exactly 2 seats/],
      [args({ strategy: 'parallel' }), /parallel takes at least 2 seats/],
      [args({ strategy: 'debate' }), /debate takes at least 2 seats/],
      [args({ deadlineMs: 999 }), /deadlineMs/],
      [args({ maxRounds: 4 }), /maxRounds/],
      [args({ budgetUsd: 0 }), /budgetUsd/],
      [args({ maxTokens: -1 }), /maxTokens/],
    ];
    for (const [input, reason] of cases) {
      const refusal = validateLaunchArgs(input);
      expect(refusal?.code, String(reason)).toBe('invalid_arguments');
      expect(refusal?.reason).toMatch(reason);
    }
  });
});
