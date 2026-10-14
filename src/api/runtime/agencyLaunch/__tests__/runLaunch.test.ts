/**
 * The launch engine (spec 4.8), with a fake host and fake seats under the real agency(): validation, the child's
 * caps, one case per refusal code, the run and its statuses, and the deadline and the grace. Pure engine logic; the
 * surfaces' own tests run the real seats.
 */
import { describe, expect, it } from 'vitest';
import { SpendBudget } from '../../spendBudget.js';
import { childBudgetCaps, validateLaunchArgs } from '../runLaunch.js';
import type { LaunchAgencyArgs } from '../types.js';
import { resolveLaunchLimits } from '../types.js';

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

describe('childBudgetCaps', () => {
  const limits = resolveLaunchLimits({});
  const pool = (tokens = 200_000, usd = Number.POSITIVE_INFINITY) => new SpendBudget({ maxCostUSD: usd, maxTotalTokens: tokens, unpriced: 'allow' });

  it("takes the parent's remaining times the share, the pool and the arguments, the least of each", () => {
    const parent = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 20_000, unpriced: 'allow' });
    parent.record(0.2, 6_000, 'step');
    expect(childBudgetCaps(parent, pool(), limits, {}, 2_000)).toEqual({ maxCostUSD: 0.4, maxTotalTokens: 7_000 });
    expect(childBudgetCaps(parent, pool(5_000, 0.1), limits, {}, 2_000)).toEqual({ maxCostUSD: 0.1, maxTotalTokens: 5_000 });
    expect(childBudgetCaps(parent, pool(), limits, { budgetUsd: 0.05, maxTokens: 4_500 }, 2_000)).toEqual({ maxCostUSD: 0.05, maxTotalTokens: 4_500 });
  });

  it('a parent with no token cap, or no budget at all, leaves the pool to bound the tokens', () => {
    const noTokenCap = new SpendBudget({ maxCostUSD: 1, unpriced: 'allow' });
    expect(childBudgetCaps(noTokenCap, pool(3_000), limits, {}, 1_000)).toEqual({ maxCostUSD: 0.5, maxTotalTokens: 3_000 });
    expect(childBudgetCaps(undefined, pool(3_000), limits, {}, 1_000)).toEqual({ maxCostUSD: Number.POSITIVE_INFINITY, maxTotalTokens: 3_000 });
  });

  it("an unpriced parent's spend counts tokens and no dollars", () => {
    const parent = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 10_000, unpriced: 'allow' });
    parent.record(undefined, 4_000, 'step');
    expect(childBudgetCaps(parent, pool(), limits, {}, 1_000)).toEqual({ maxCostUSD: 0.5, maxTotalTokens: 3_000 });
  });

  it('refuses a cap that cannot cover one call, and a spent parent', () => {
    expect(childBudgetCaps(undefined, pool(2_500), limits, {}, 1_000)).toMatchObject({ code: 'budget_unavailable' });
    expect(childBudgetCaps(undefined, pool(3_000), limits, {}, 1_000)).toEqual({ maxCostUSD: Number.POSITIVE_INFINITY, maxTotalTokens: 3_000 });
    const spent = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 10_000, unpriced: 'allow' });
    spent.record(1, 1_000, 'step');
    expect(childBudgetCaps(spent, pool(), limits, {}, 1_000)).toMatchObject({ code: 'budget_unavailable', reason: expect.stringContaining('dollars') });
  });
});
