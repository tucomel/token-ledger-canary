import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, appendFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexTranscriptParser, CodexTranscripts } from './codex-transcripts.ts';

const thread = '11111111-1111-4111-8111-111111111111';
const adapter = '22222222-2222-4222-8222-222222222222';
const started = '2026-10-21T10:00:00.000Z', ended = '2026-10-21T10:00:01.000Z';
const event = (type: string, payload: object, timestamp = started) => JSON.stringify({ type, timestamp, payload });
const message = (type: string, fields = {}, timestamp = started) => event('event_msg', { type, ...fields }, timestamp);
const begin = (model = 'gpt-6-luna', tier = 'default', turn = 'native-turn') => [
  message('task_started', { turn_id: turn }),
  event('turn_context', { turn_id: turn, model }),
  message('thread_settings_applied', { thread_settings: { model, service_tier: tier } }),
];
const usage = (total: number, extra: object = {}) => message('token_count', { info: {
  total_token_usage: { input_tokens: total, cached_input_tokens: total / 2, output_tokens: total / 10 },
  last_token_usage: { input_tokens: 100, cached_input_tokens: 50, cache_write_input_tokens: 40, output_tokens: 10, ...extra },
  model_context_window: 258400,
} });
const finish = (turn = 'native-turn') => message('task_complete', { turn_id: turn }, ended);
const agent = { id: 'agent', provider: 'codex-work', model: 'gpt-6-luna', runtimeInfo: { sessionId: thread } };
function parse(lines: string[]) {
  const parser = new CodexTranscriptParser();
  lines.forEach((line, index) => parser.accept(line, index));
  return parser;
}

test('equal-size real calls count twice, replayed cumulative snapshots count once', () => {
  const parser = parse([...begin(), usage(100), usage(100), usage(200), usage(200), finish()]);
  const row = parser.records(agent, thread, thread).records[0];
  assert.equal(row.modelCalls, 2); assert.equal(row.input, 200); assert.equal(row.cached, 100);
  assert.equal(row.cacheWrite, 80); assert.equal(row.output, 20);
  assert.notEqual(row.requests![0].id, row.requests![1].id);
  assert.equal(row.serviceTier, 'default');
  assert.deepEqual(row.accountingWarnings, ['cache-retention-unknown-30m-assumed']);
});

test('records the applied Fast tier rather than the current UI model', () => {
  const row = parse([...begin('gpt-6.1-sol', 'priority'), usage(100), finish()]).records(agent, thread, thread).records[0];
  assert.equal(row.model, 'gpt-6.1-sol'); assert.equal(row.serviceTier, 'priority');
  assert.equal(row.requests![0].serviceTier, 'priority');
});

test('actual request models and processing tiers survive a mid-turn reroute', () => {
  const parser = parse([...begin(), usage(100), message('model_rerouted', { to_model: 'gpt-6.1-sol' }),
    message('thread_settings_applied', { thread_settings: { service_tier: 'ultrafast' } }), usage(200), finish()]);
  const row = parser.records(agent, thread, thread).records[0];
  assert.deepEqual(row.requests!.map(r => [r.model, r.serviceTier]), [['gpt-6-luna', 'default'], ['gpt-6.1-sol', 'ultrafast']]);
  assert.equal(row.serviceTier, null);
});

test('malformed counters never manufacture negative uncached input', () => {
  const row = parse([...begin(), usage(100, { cache_write_input_tokens: 100 }), usage(200), finish()]).records(agent, thread, thread).records[0];
  assert.equal(row.modelCalls, 1); assert.ok(row.accountingWarnings!.includes('invalid-token-sample'));
});

test('missing dimensions remain unknown and are explicitly marked', () => {
  const parser = parse([message('task_started', { turn_id: 't' }), event('turn_context', { turn_id: 't', model: 'gpt-6-luna' }),
    usage(100, { cache_write_input_tokens: undefined }), finish('t')]);
  const row = parser.records(agent, thread, thread).records[0];
  assert.equal(row.cacheWrite, undefined); assert.equal(row.serviceTier, null);
  assert.ok(row.accountingWarnings!.includes('cache-write-count-unavailable'));
  assert.ok(row.accountingWarnings!.includes('processing-tier-unknown-standard-assumed'));
});

test('known retention and canceled turn status are preserved without storing message content', () => {
  const parser = parse([...begin(), message('thread_settings_applied', { thread_settings: { prompt_cache_retention: '12h' } }),
    usage(100), message('agent_message', { message: 'private-message-not-for-the-ledger' }),
    message('turn_aborted', { turn_id: 'native-turn' }, ended)]);
  const row = parser.records(agent, thread, thread).records[0];
  assert.equal(row.requests![0].cacheRetention, '12h'); assert.equal(row.status, 'canceled');
  assert.deepEqual(row.accountingWarnings, []); assert.equal(row.quality, 'exact');
  assert.ok(!JSON.stringify(row).includes('private-message'));
});

test('replaying a completed turn does not re-bill it; a new native turn remains distinct', () => {
  const lines = [...begin(), usage(100), finish()];
  const parser = parse([...lines, ...lines, ...begin('gpt-6-luna', 'default', 'second'), usage(100), finish('second')]);
  const rows = parser.records(agent, thread, thread).records;
  assert.equal(rows.length, 2); assert.equal(rows[0].modelCalls, 1); assert.equal(rows[1].modelCalls, 1);
});

test('custom CODEX_HOME, inherited aliases, ACP mapping and incomplete tails recover idempotently', async () => {
  const home = await mkdtemp(join(tmpdir(), 'canary-transcripts-'));
  try {
    const codex = join(home, 'separate-codex-home');
    await mkdir(join(codex, 'sessions', '2026', '10'), { recursive: true });
    await mkdir(join(codex, 'paseo-usage'), { recursive: true });
    await writeFile(join(home, 'config.json'), JSON.stringify({ agents: { providers: {
      work: { extends: 'codex', env: { CODEX_HOME: codex } },
      alias: { extends: 'work' },
      'codex-work': { extends: 'acp', env: { CODEX_HOME: codex } },
    } } }));
    await writeFile(join(codex, 'paseo-usage', adapter + '.json'), JSON.stringify({ threadId: thread }));
    const file = join(codex, 'sessions', '2026', '10', 'rollout-' + thread + '.jsonl');
    const tail = usage(200);
    await writeFile(file, [...begin(), usage(100), tail.slice(0, 60)].join('\n'));
    const reader = new CodexTranscripts(home);
    reader.note({ ...agent, runtimeInfo: { sessionId: adapter } });
    assert.equal((await reader.read(agent.id))!.active!.modelCalls, 1);
    await appendFile(file, tail.slice(60) + '\n' + finish() + '\n');
    const first = (await reader.read(agent.id))!;
    assert.equal(first.records[0].modelCalls, 2); assert.equal(first.records[0].sessionId, adapter);
    assert.equal(first.records[0].nativeSessionId, thread); assert.equal(first.active, null);
    assert.deepEqual(await reader.read(agent.id), first);
    reader.note({ ...agent, provider: 'alias' });
    assert.equal((await reader.read(agent.id))!.records[0].modelCalls, 2);
    await writeFile(file, [...begin(), usage(100), finish()].join('\n') + '\n');
    assert.equal((await reader.read(agent.id))!.records[0].modelCalls, 1, 'truncation resets the file cursor');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('invalid session identifiers cannot escape the configured Codex home', async () => {
  const reader = new CodexTranscripts('/does-not-exist');
  reader.note({ ...agent, runtimeInfo: { sessionId: '../../credentials' } });
  assert.equal(await reader.read(agent.id), null);
});

test('cached paths recover immediately when Codex archives or restores a session', async () => {
  const home = await mkdtemp(join(tmpdir(), 'canary-transcript-move-'));
  try {
    const codex = join(home, 'codex');
    await mkdir(join(codex, 'sessions'), { recursive: true });
    await mkdir(join(codex, 'archived_sessions'), { recursive: true });
    await writeFile(join(home, 'config.json'), JSON.stringify({ agents: { providers: {
      'codex-work': { extends: 'codex', env: { CODEX_HOME: codex } },
    } } }));
    const active = join(codex, 'sessions', 'rollout-' + thread + '.jsonl');
    const archived = join(codex, 'archived_sessions', 'rollout-' + thread + '.jsonl');
    await writeFile(active, [...begin(), usage(100), finish()].join('\n') + '\n');
    const reader = new CodexTranscripts(home);
    reader.note(agent);
    const original = await reader.read(agent.id);
    assert.equal(original!.records[0].modelCalls, 1);
    await rename(active, archived);
    assert.deepEqual(await reader.read(agent.id), original);
    await rename(archived, active);
    assert.deepEqual(await reader.read(agent.id), original);
    await rm(active);
    assert.equal(await reader.read(agent.id), null);
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('GPT-5.5 crossing its limit marks earlier session requests for repricing', () => {
  const parser = parse([...begin('gpt-5.5'), usage(100), finish(),
    ...begin('gpt-5.5', 'default', 'second'), usage(400000, { input_tokens: 300000, cached_input_tokens: 150000, cache_write_input_tokens: 0 }), finish('second')]);
  const rows = parser.records(agent, thread, thread).records;
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.requests!.every(request => request.sessionLongContext)));
});
