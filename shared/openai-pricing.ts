import type { ModelPricing } from './pricing.ts';
import { canonicalModel } from './pricing.ts';

// USD / million tokens, verified 2026-10-21 against the official model pages.
// https://developers.openai.com/api/docs/pricing
const models: Record<string, ModelPricing & { fast?: boolean; ultrafast?: boolean; legacy?: boolean }> = {
  'gpt-6-luna': { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5, fast: true },
  'gpt-6-1-sol': { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10, fast: true, ultrafast: true },
  'gpt-6-sol': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10, fast: true },
  'gpt-6-astra': { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50, fast: true, ultrafast: true },
  'gpt-5-6-sol': { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20, fast: true },
  'gpt-5-6-terra': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12 },
  'gpt-5-6-luna': { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2 },
  'gpt-5-5': { input: 5, cacheRead: 0.5, cacheWrite: 5, output: 30, legacy: true },
};

export function knownOpenAiModel(model: string): boolean {
  return Object.hasOwn(models, canonicalModel(model).replace(/-\d{8}$/, ''));
}

export function legacySessionPricing(model: string): boolean {
  return models[canonicalModel(model).replace(/-\d{8}$/, '')]?.legacy === true;
}

export function processingMultiplier(model: string, tier?: string | null): number | null {
  if (!tier || tier === 'default' || tier === 'standard') return 1;
  const rates = models[canonicalModel(model).replace(/-\d{8}$/, '')];
  if (!rates) return null;
  if ((tier === 'priority' || tier === 'fast') && rates.fast) return 2;
  if (tier === 'flex' || tier === 'batch') return 0.5;
  if (tier === 'ultrafast' && rates.ultrafast) return 6;
  return null;
}

export function openAiBasePricing(model: string): ModelPricing | null {
  const rates = models[canonicalModel(model).replace(/-\d{8}$/, '')];
  if (!rates) return null;
  const { ultrafast: _ultrafast, fast: _fast, legacy: _legacy, ...price } = rates;
  return price;
}

export function adjustOpenAiPricing(
  model: string, price: ModelPricing, prompt: number,
  tier?: string | null, retention?: string | null, applyLongContext = true,
): ModelPricing | null {
  if (retention != null && !['in_memory', '30m', '12h', 'extended'].includes(retention)) return null;
  const speed = processingMultiplier(model, tier);
  if (speed === null) return null;
  const long = applyLongContext && knownOpenAiModel(model) && prompt > 272_000;
  const legacy = legacySessionPricing(model);
  const write = !legacy && (retention === '12h' || retention === 'extended') ? 2 : 1;
  return {
    input: price.input * speed * (long ? 2 : 1),
    cacheRead: price.cacheRead * speed * (long ? 2 : 1),
    ...(price.cacheWrite === undefined ? {} : { cacheWrite: price.cacheWrite * speed * (long ? 2 : 1) * write }),
    output: price.output * speed * (long ? 1.5 : 1),
  };
}
