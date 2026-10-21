import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const home = await mkdtemp(join(tmpdir(), 'canary-pricing-'));
const oldHome = process.env.PASEO_HOME;
process.env.PASEO_HOME = home;
const dir = join(home, 'plugins', 'token-ledger-canary');
await mkdir(dir, { recursive: true });
await writeFile(join(dir, 'pricing.json'), JSON.stringify({ version: 1, currency: 'USD', prices: [] }));
await writeFile(join(dir, 'openrouter-pricing.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), prices: [] }));
const { ensurePricing, estimateUsageCost } = await import('./pricing.ts');
await ensurePricing();
after(async () => {
  if (oldHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = oldHome;
  await rm(home, { recursive: true, force: true });
});
const base = { provider: 'codex-canary', model: 'gpt-6-luna', input: 100000, cached: 80000, cacheWrite: 10000, output: 1000 };
const equal = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('cache writes are priced separately without double-counting inclusive input', () => {
  const result = estimateUsageCost(base);
  equal(result.effectiveCostUsd, .00355);
  equal(result.costBreakdown!.inUsd, .001);
  equal(result.costBreakdown!.cacheWriteUsd!, .00125);
  assert.equal(result.costSource, 'builtin');
});
test('Fast, Ultrafast and Flex use the actual processing mode', () => {
  const sol = { ...base, model: 'gpt-6.1-sol' };
  equal(estimateUsageCost({ ...sol, serviceTier: 'default' }).effectiveCostUsd, .063);
  equal(estimateUsageCost({ ...sol, serviceTier: 'priority' }).effectiveCostUsd, .126);
  equal(estimateUsageCost({ ...sol, serviceTier: 'ultrafast' }).effectiveCostUsd, .378);
  equal(estimateUsageCost({ ...sol, serviceTier: 'flex' }).effectiveCostUsd, .0315);
});
test('long context is applied to the whole request above the published boundary', () => {
  equal(estimateUsageCost({ ...base, input: 300000, cached: 250000, cacheWrite: 40000 }).effectiveCostUsd, .01775);
  equal(estimateUsageCost({ ...base, input: 272000, cached: 250000, cacheWrite: 0 }).effectiveCostUsd, .0052);
  equal(estimateUsageCost({ ...base, input: 272001, cached: 250000, cacheWrite: 0 }).effectiveCostUsd, .0101502);
});
test('session sums never turn short requests into an expensive long-context request', () => {
  const request = { input: 200000, cached: 150000, cacheWrite: 0, output: 1000 };
  equal(estimateUsageCost({ ...base, input: 400000, cached: 300000, cacheWrite: 0, output: 2000, requests: [request, request] }).effectiveCostUsd, .014);
});
test('mixed request models and speeds are priced individually', () => {
  const usage = { input: 100000, cached: 90000, output: 1000 };
  equal(estimateUsageCost({ ...base, requests: [
    { ...usage, model: 'gpt-6-luna', serviceTier: 'default' },
    { ...usage, model: 'gpt-6.1-sol', serviceTier: 'priority' },
  ] }).effectiveCostUsd, .0804);
});
test('extended and mixed cache-write retention use their own rates', () => {
  equal(estimateUsageCost({ ...base, requests: [{ ...base, cacheRetention: '12h' }] }).effectiveCostUsd, .0048);
  equal(estimateUsageCost({ ...base, requests: [{ ...base, cacheWrite12h: 5000 }] }).effectiveCostUsd, .004175);
  assert.equal(estimateUsageCost({ ...base, requests: [{ ...base, cacheWrite12h: 10001 }] }).effectiveCostUsd, null);
});
test('unsupported models and processing modes do not inherit a guessed price', () => {
  assert.equal(estimateUsageCost({ ...base, model: 'unknown-gpt-999' }).effectiveCostUsd, null);
  assert.equal(estimateUsageCost({ ...base, serviceTier: 'ultrafast' }).effectiveCostUsd, null);
  assert.equal(estimateUsageCost({ ...base, serviceTier: 'unknown-speed' }).effectiveCostUsd, null);
  assert.equal(estimateUsageCost({ ...base, requests: [{ ...base, model: null }] }).effectiveCostUsd, null);
  assert.equal(estimateUsageCost({ ...base, requests: [{ ...base, cacheRetention: 'unknown-retention' }] }).effectiveCostUsd, null);
});
test('published older model prices and aliases are preserved', () => {
  equal(estimateUsageCost({ ...base, model: 'gpt-6-sol', cacheWrite: 0 }).effectiveCostUsd, .066);
  equal(estimateUsageCost({ ...base, model: 'gpt-5.6-sol', cacheWrite: 0 }).effectiveCostUsd, .132);
  equal(estimateUsageCost({ ...base, model: 'gpt-5.6-terra', cacheWrite: 0 }).effectiveCostUsd, .068);
  equal(estimateUsageCost({ ...base, model: 'gpt-5.6-luna', cacheWrite: 0 }).effectiveCostUsd, .0068);
  equal(estimateUsageCost({ ...base, model: 'openai/gpt-6.1-sol-20261021', cacheWrite: 0 }).effectiveCostUsd, .058);
});
test('GPT-5.5 session long-context flag reprices earlier requests without adding a cache-write premium', () => {
  const request = { ...base, model: 'gpt-5.5', sessionLongContext: true };
  equal(estimateUsageCost({ ...base, requests: [request] }).effectiveCostUsd, .325);
});
