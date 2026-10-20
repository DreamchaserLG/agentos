/**
 * @module core/llm/providers/implementations/billing-probe-model
 *
 * The model a gateway provider's billing probe sends its smallest completion
 * to. A key the pool took out for `billing` comes back only when a billable
 * request passes, and a gateway (OpenRouter, Requesty) can serve a free model
 * to an account with no credit left (OpenRouter's limits page names only a
 * negative balance as refusing free models; https://openrouter.ai/docs/api-reference/limits,
 * read 19 October 2026), so the probe must go to a model with a price: the
 * provider's default model only when the catalog lists it with one.
 */
import type { ModelInfo } from '../IProvider';

/**
 * A catalog entry's listed input and output prices together, when it is a
 * chat model whose two prices are finite, not negative and add up to more
 * than zero; undefined otherwise. An embeddings model, a model with either
 * price missing, and one with a negative price (OpenRouter lists its auto
 * router at -1) have none.
 */
function pricedChatModelPrice(model: ModelInfo): number | undefined {
  if (!model.capabilities.includes('chat') || model.capabilities.includes('embeddings')) return undefined;
  const input = model.pricePer1MTokensInput;
  const output = model.pricePer1MTokensOutput;
  if (typeof input !== 'number' || typeof output !== 'number') return undefined;
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return undefined;
  const price = input + output;
  return price > 0 ? price : undefined;
}

/**
 * The cheapest chat model of a catalog that lists a price above zero, by its
 * listed input and output prices together. A model with either price missing,
 * not finite or negative (OpenRouter lists its auto router at -1) is skipped,
 * as is an embeddings model. Undefined when no model qualifies; a probe with
 * no model to send has no verdict.
 */
export function cheapestPricedChatModel(models: Iterable<ModelInfo>): string | undefined {
  let best: { modelId: string; price: number } | undefined;
  for (const model of models) {
    const price = pricedChatModelPrice(model);
    if (price === undefined) continue;
    if (best === undefined || price < best.price) best = { modelId: model.modelId, price };
  }
  return best?.modelId;
}

/**
 * The model a billing probe sends: the provider's default model when the
 * catalog lists it as a chat model with a price above zero, else the
 * catalog's cheapest such model. A free default (OpenRouter lists its `:free`
 * variants at zero) can answer 200 for an account with no credit, so the key
 * would come back only to fail its next request, and a default the catalog
 * does not list has no known price. Undefined when the catalog has no priced
 * chat model.
 */
export function billingProbeModel(defaultModelId: string | undefined, catalog: ReadonlyMap<string, ModelInfo>): string | undefined {
  const listed = defaultModelId ? catalog.get(defaultModelId) : undefined;
  if (listed !== undefined && pricedChatModelPrice(listed) !== undefined) return listed.modelId;
  return cheapestPricedChatModel(catalog.values());
}
