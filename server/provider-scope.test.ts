import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaseoApi, PaseoAgentTimelineEvent } from './paseo-types.ts';
import { finalizeTurn } from '../shared/aggregate.ts';
import { createState, noteUsage, closeTurn } from './turns.ts';
import { ownedSnapshot } from '../shared/subscription-test-helpers.ts';

test('only codex-canary is tracked and priced across legacy history, journal recovery, hooks and RPCs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'canary-provider-scope-'));
  const oldHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const dir = join(home, 'plugins', 'token-ledger-canary');
  const snapshots = ['codex-canary', 'claude', 'codex', 'cursor', 'codex-canary-metered'].map(provider => ({
    id: provider, provider, model: 'gpt-6-luna', workspaceId: 'w', title: provider, cwd: home, parentAgentId: null,
    status: 'idle', updatedAt: '2026-10-21T10:00:00Z',
  }));
  const history = snapshots.map(snapshot => ({ ...finalizeTurn({
    agentId: snapshot.id, turnId: 'old', provider: snapshot.provider, model: snapshot.model,
    startedAt: '2026-10-21T10:00:00Z', endedAt: '2026-10-21T10:00:01Z', status: 'completed',
    observations: [], finalUsage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 }, prevSessionCostUsd: null,
  }), costUsd: snapshot.provider === 'codex-canary' ? 1 : 1000 }));
  // Even a legacy row attributed to the same agent is selected by its provider.
  history.push({ ...history[1], id: 'mixed-history', agentId: 'codex-canary' });
  const excluded = createState();
  noteUsage(excluded, { ...snapshots[1], activeTurn: { turnId: 'resurrected', startedAt: '2026-10-21T10:00:00Z' },
    lastUsage: { inputTokens: 999, outputTokens: 999 } });
  const pending = closeTurn('excluded-pending', structuredClone(excluded), 'completed', null, '2026-10-21T10:00:02Z')!;
  await mkdir(dir, { recursive: true });
  const historyText = history.map(record => JSON.stringify(record)).join('\n') + '\n';
  await writeFile(join(dir, 'ledger.jsonl'), historyText);
  await writeFile(join(dir, 'tracker-state.json'), JSON.stringify({ v: 1, states: [['claude', excluded]], pending: [pending] }));
  await writeFile(join(dir, 'pricing.json'), JSON.stringify({ version: 1, currency: 'USD', prices: [] }));
  await writeFile(join(dir, 'openrouter-pricing.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), prices: [] }));
  const watches: string[] = [];
  const published: string[] = [];
  const paseo = {
    agents: {
      list: async () => ownedSnapshot({ entries: snapshots.map(agent => ({ agent })), pageInfo: { nextCursor: null } }).page,
      ref: (id: string) => ({ refresh: async () => {}, current: () => snapshots.find(agent => agent.id === id),
        timeline: {
          subscribe: () => { watches.push(id); return { ready: Promise.resolve(), release: async () => {} }; },
          append: async () => { published.push(id); },
        },
      }),
    },
    workspaces: { list: async () => ownedSnapshot({ entries: [{ id: 'w', title: 'Test' }], pageInfo: { nextCursor: null } }).page },
  } as unknown as PaseoApi;
  const tracker = await import('./tracker.ts');
  const store = await import('./store.ts');
  try {
    await tracker.ensureTracker(paseo);
    assert.deepEqual(watches, ['codex-canary'], 'excluded agents have no timeline demand');
    for (const snapshot of snapshots.slice(1)) {
      await tracker.prepareAgent(paseo, snapshot.id);
      await tracker.observeStart({ agent: snapshot, turnId: 'ignored' }, paseo);
      tracker.observeStream({ agentId: snapshot.id, timestamp: '2026-10-21T11:00:00Z',
        event: { type: 'turn_completed', provider: snapshot.provider, turnId: 'ignored', usage: { inputTokens: 999999 } },
      } as PaseoAgentTimelineEvent);
      await tracker.observeEnd({ agent: snapshot, turnId: 'ignored', outcome: { kind: 'completed' }, timeline: [] }, paseo);
      const result = await tracker.handleSync({ agentId: snapshot.id }, { paseo });
      assert.equal(result.summary.turns, 0);
      assert.equal(result.summary.effectiveCostUsd, null);
      assert.deepEqual(result.records, []);
      assert.equal(result.inFlight, null);
      assert.equal(result.ctx, null);
    }
    const allowed = await tracker.handleSync({ agentId: 'codex-canary' }, { paseo });
    assert.equal(allowed.records.length, 1);
    assert.equal(allowed.summary.effectiveCostUsd, 1);
    const overview = await tracker.handleOverview({}, { paseo });
    assert.equal(overview.totals.effectiveCostUsd, 1);
    assert.equal(overview.totals.turns, 1);
    assert.deepEqual(overview.groups.flatMap(group => group.agents.map(agent => agent.provider)), ['codex-canary']);
    assert.equal(await readFile(store.dataFilePath(), 'utf8'), historyText, 'excluded history is preserved on disk');
    assert.deepEqual(watches, ['codex-canary']);
    tracker.observeStream({ agentId: 'codex-canary', timestamp: '2026-10-21T11:00:00Z',
      event: { type: 'turn_started', provider: 'codex', turnId: 'allowed' } });
    tracker.observeStream({ agentId: 'codex-canary', timestamp: '2026-10-21T11:00:01Z',
      event: { type: 'turn_completed', provider: 'codex', turnId: 'allowed', usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 } } });
    const after = await tracker.handleSync({ agentId: 'codex-canary' }, { paseo });
    assert.equal(after.summary.turns, 2);
    assert.equal(store.allRecords().length, history.length + 1);
    await tracker.stopTracker();
    assert.deepEqual(published, ['codex-canary']);
    const journal = JSON.parse(await readFile(join(dir, 'tracker-state.json'), 'utf8'));
    assert.ok(journal.states.every(([, state]: [string, { provider: string }]) => state.provider === 'codex-canary'));
    assert.deepEqual(journal.pending, []);
  } finally {
    await tracker.stopTracker();
    if (oldHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});
