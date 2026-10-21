import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeTurn } from '../shared/aggregate.ts';

test('canonical transcript corrections replace incomplete ACP telemetry and survive replay without duplicate charges', async () => {
  const home = await mkdtemp(join(tmpdir(), 'canary-native-store-'));
  const oldHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  try {
    const store = await import('./store.ts');
    const partial = { ...finalizeTurn({ agentId: 'a', provider: 'codex-acp', model: 'gpt-6-luna', turnId: 'paseo-turn',
      startedAt: '2026-10-21T10:00:00Z', endedAt: '2026-10-21T10:00:02Z', status: 'completed',
      observations: [], finalUsage: { inputTokens: 100, cachedInputTokens: 90, outputTokens: 5 }, prevSessionCostUsd: null }), sessionId: 'adapter' };
    const unrelated = { ...partial, id: 'unrelated', agentId: 'other', sessionId: 'another-session' };
    await store.appendRecord(partial); await store.appendRecord(unrelated);
    const corrected = { ...partial, id: 'codex:native-session:native-turn', nativeTurnId: 'native-turn',
      nativeSessionId: 'native-session', source: 'codex_transcript', input: 300, cached: 270, cacheWrite: 20,
      modelCalls: 3, quality: 'exact' as const };
    await store.upsertTranscriptRecords([corrected]);
    assert.equal(store.allRecords().length, 2);
    assert.equal(store.allRecords().find(r => r.agentId === 'a')!.modelCalls, 3);
    const revision = store.storeRevision();
    await store.upsertTranscriptRecords([corrected]);
    assert.equal(store.storeRevision(), revision, 'an unchanged refresh must not rewrite history');
    await store.appendRecord(partial); // a late lifecycle notification
    await store.upsertTranscriptRecords([corrected]);
    assert.equal(store.allRecords().length, 2);
    assert.deepEqual((await readFile(store.dataFilePath(), 'utf8')).trim().split('\n').map(line => JSON.parse(line)), store.allRecords());
    await store.upsertTranscriptRecords([{ ...corrected, agentId: 'second-attachment' }]);
    assert.equal(store.allRecords().filter(r => r.id === corrected.id).length, 1, 'a shared native thread has one accounting owner');
    assert.equal(store.allRecords().find(r => r.id === corrected.id)!.agentId, 'a');
  } finally {
    if (oldHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});
