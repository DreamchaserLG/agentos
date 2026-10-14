/**
 * @file runLaunch.ts
 * The launch engine: one run of `launch_agency` on either surface, through a host that knows the surface (gmi() or
 * the full runtime). It validates, resolves the parent (a frame naming a launch in flight, or the turn itself), applies
 * the bounds, sizes the child budget, admits the launch, builds the seats, runs the child agency once, settles under one
 * deadline and one grace, closes the team and returns one tool result. It never throws (spec 4.8).
 * @internal
 */
import { IDENTIFIER_PATTERN } from '../../../cognition/emergent/ToolName.js';
import type { AgencyStrategy } from '../../types.js';
import type { SpendBudget } from '../spendBudget.js';
import { MAX_ROLE_CHARS, MIN_LAUNCH_TOKENS, type LaunchAgencyArgs, type LaunchLimits, type LaunchRefusal } from './types.js';

/** The six strategies a launch offers (spec D17). */
const STRATEGIES: readonly AgencyStrategy[] = ['sequential', 'parallel', 'debate', 'review-loop', 'hierarchical', 'graph'];
const ARG_KEYS: ReadonlySet<string> = new Set(['goal', 'strategy', 'seats', 'budgetUsd', 'maxTokens', 'deadlineMs', 'maxRounds']);
const SEAT_KEYS: ReadonlySet<string> = new Set(['role', 'instructions', 'agentKey', 'personaId', 'brief', 'tools', 'dependsOn']);
/**
 * The role names EmergentAgentForge reserves (private there). A role also matches the forge's identifier pattern
 * ({@link IDENTIFIER_PATTERN}) and never starts with the hierarchical strategy's own tool prefix: a role becomes a
 * `delegate_to_<role>` tool.
 */
const RESERVED_ROLES: ReadonlySet<string> = new Set(['spawn_specialist', 'delegate_to_self', 'final_answer', 'plan']);
const MAX_GOAL_CHARS = 8_000;
const MAX_INSTRUCTIONS_CHARS = 8_192;
const MAX_BRIEF_CHARS = 1_000;

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * Step 1: the arguments' own rules (types, required fields and the strategy's names are the input schema's too, so a
 * call the schema refuses never reaches here). Counts against a host's bounds are step 3's.
 *
 * @returns `invalid_arguments` naming the first problem, or undefined.
 */
export function validateLaunchArgs(args: LaunchAgencyArgs): LaunchRefusal | undefined {
  const invalid = (reason: string): LaunchRefusal => ({ code: 'invalid_arguments', reason });
  if (typeof args !== 'object' || args === null) return invalid('the arguments must be an object');
  for (const key of Object.keys(args)) if (!ARG_KEYS.has(key)) return invalid(`unknown argument '${key}'`);
  if (typeof args.goal !== 'string' || args.goal.trim().length === 0 || args.goal.length > MAX_GOAL_CHARS) {
    return invalid(`goal must be 1 to ${MAX_GOAL_CHARS.toLocaleString('en-US')} characters`);
  }
  const strategy = args.strategy ?? 'sequential';
  if (!STRATEGIES.includes(strategy)) return invalid(`unknown strategy '${String(strategy)}'; one of ${STRATEGIES.join(', ')}`);
  if (!Array.isArray(args.seats) || args.seats.length === 0) return invalid('seats must name at least one seat');

  const roles = new Set<string>();
  for (let i = 0; i < args.seats.length; i++) {
    const seat = args.seats[i] as unknown as Record<string, unknown>;
    if (typeof seat !== 'object' || seat === null) return invalid(`seat ${i + 1} must be an object`);
    for (const key of Object.keys(seat)) if (!SEAT_KEYS.has(key)) return invalid(`seat ${i + 1}: unknown key '${key}'`);
    const role = seat.role;
    if (typeof role !== 'string' || !IDENTIFIER_PATTERN.test(role)) {
      return invalid(`seat ${i + 1}: a role starts with a letter and holds only letters, digits, '_' and '-'`);
    }
    if (role.length > MAX_ROLE_CHARS) return invalid(`seat '${role.slice(0, 20)}...': a role is at most ${MAX_ROLE_CHARS} characters`);
    if (RESERVED_ROLES.has(role) || role.startsWith('delegate_to_')) return invalid(`seat '${role}': the role is a name the hierarchical strategy uses`);
    if (roles.has(role)) return invalid(`seat '${role}': roles must be unique`);
    roles.add(role);
    const forms = ['instructions', 'agentKey', 'personaId'].filter((form) => seat[form] !== undefined);
    if (forms.length !== 1) return invalid(`seat '${role}': name exactly one of instructions, agentKey and personaId`);
    const form = forms[0];
    const value = seat[form];
    if (typeof value !== 'string' || value.trim().length === 0) return invalid(`seat '${role}': ${form} must be a non-blank string`);
    if (form === 'instructions') {
      if (value.length > MAX_INSTRUCTIONS_CHARS) return invalid(`seat '${role}': instructions are at most ${MAX_INSTRUCTIONS_CHARS.toLocaleString('en-US')} characters`);
      if (seat.brief !== undefined) return invalid(`seat '${role}': a brief is for a persistent member; put it in the instructions`);
    }
    if (seat.brief !== undefined && (typeof seat.brief !== 'string' || seat.brief.length > MAX_BRIEF_CHARS)) {
      return invalid(`seat '${role}': a brief is a string of at most ${MAX_BRIEF_CHARS.toLocaleString('en-US')} characters`);
    }
    if (seat.tools !== undefined && !isStringArray(seat.tools)) return invalid(`seat '${role}': tools must be a list of tool names`);
    if (seat.dependsOn !== undefined && !isStringArray(seat.dependsOn)) return invalid(`seat '${role}': dependsOn must be a list of roles`);
  }

  const dependsOn = new Map<string, string[]>();
  for (const seat of args.seats) {
    const deps = seat.dependsOn ?? [];
    for (const dep of deps) {
      if (dep === seat.role || !roles.has(dep)) return invalid(`seat '${seat.role}': dependsOn names '${dep}', which is not another seat`);
    }
    dependsOn.set(seat.role, deps);
  }
  // A cycle: a seat that, through dependsOn, waits for itself.
  const visiting = new Set<string>();
  const done = new Set<string>();
  const cyclic = (role: string): boolean => {
    if (done.has(role)) return false;
    if (visiting.has(role)) return true;
    visiting.add(role);
    const found = (dependsOn.get(role) ?? []).some(cyclic);
    visiting.delete(role);
    done.add(role);
    return found;
  };
  for (const role of roles) if (cyclic(role)) return invalid(`dependsOn makes a cycle through '${role}'`);

  if (strategy === 'review-loop' && args.seats.length !== 2) return invalid('review-loop takes exactly 2 seats');
  if ((strategy === 'parallel' || strategy === 'debate') && args.seats.length < 2) return invalid(`${strategy} takes at least 2 seats`);
  if (args.deadlineMs !== undefined && !(Number.isFinite(args.deadlineMs) && args.deadlineMs >= 1_000)) return invalid('deadlineMs must be at least 1,000');
  if (args.maxRounds !== undefined && !(Number.isInteger(args.maxRounds) && args.maxRounds >= 1 && args.maxRounds <= 3)) return invalid('maxRounds must be 1, 2 or 3');
  if (args.budgetUsd !== undefined && !(Number.isFinite(args.budgetUsd) && args.budgetUsd > 0)) return invalid('budgetUsd must be above 0');
  if (args.maxTokens !== undefined && !(Number.isFinite(args.maxTokens) && args.maxTokens > 0)) return invalid('maxTokens must be above 0');
  return undefined;
}

/**
 * Step 4: the child budget's caps (spec D9). Dollars: the least of `budgetUsd`, the parent's remaining dollars times
 * `budgetShare` and, at a root launch, what the turn's launch pool has left (Infinity when none of them caps). Tokens:
 * the least of `maxTokens`, the parent's remaining tokens times `budgetShare` (when it has a token cap) and the pool's
 * remaining tokens (`limits.maxLaunchTokens` when nothing else caps them).
 *
 * @param outputEstimateTokens - The output tokens one call is counted with.
 * @returns The caps, or `budget_unavailable` when the token cap cannot cover one call (`MIN_LAUNCH_TOKENS` plus the
 *   output estimate) or no dollars are left.
 */
export function childBudgetCaps(
  parent: SpendBudget | undefined,
  pool: SpendBudget | undefined,
  limits: LaunchLimits,
  args: Pick<LaunchAgencyArgs, 'budgetUsd' | 'maxTokens'>,
  outputEstimateTokens: number,
): { maxCostUSD: number; maxTotalTokens: number } | LaunchRefusal {
  const parentLeft = parent?.remaining();
  const poolLeft = pool?.remaining();
  let usd = Number.POSITIVE_INFINITY;
  if (args.budgetUsd !== undefined) usd = Math.min(usd, args.budgetUsd);
  if (parentLeft) usd = Math.min(usd, parentLeft.usd * limits.budgetShare);
  if (poolLeft) usd = Math.min(usd, poolLeft.usd);
  let tokens = Number.POSITIVE_INFINITY;
  if (args.maxTokens !== undefined) tokens = Math.min(tokens, args.maxTokens);
  if (parentLeft?.tokens !== undefined) tokens = Math.min(tokens, Math.floor(parentLeft.tokens * limits.budgetShare));
  if (poolLeft?.tokens !== undefined) tokens = Math.min(tokens, poolLeft.tokens);
  if (!Number.isFinite(tokens)) tokens = limits.maxLaunchTokens;
  const floor = MIN_LAUNCH_TOKENS + outputEstimateTokens;
  if (tokens < floor) {
    return { code: 'budget_unavailable', reason: `the launch's token cap, ${tokens}, cannot cover one call (${floor}: ${MIN_LAUNCH_TOKENS} for the prompt and ${outputEstimateTokens} for the output)` };
  }
  if (!(usd > 0)) return { code: 'budget_unavailable', reason: 'the launch has no dollars left to spend' };
  return { maxCostUSD: usd, maxTotalTokens: tokens };
}
