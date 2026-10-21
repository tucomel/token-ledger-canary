import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { TurnRecord } from '../shared/ledger.ts';
import { legacySessionPricing } from '../shared/openai-pricing.ts';

type Request = NonNullable<TurnRecord['requests']>[number];
type Turn = {
  id: string; startedAt: string; endedAt: string | null;
  status: TurnRecord['status']; model: string | null;
  requests: Request[]; warnings: Set<string>;
};
export type AccountingAgent = {
  id: string; provider: string; cwd?: string; model?: string | null;
  runtimeInfo?: { sessionId: string | null } | null;
  activeTurn?: { turnId: string; startedAt: string | null } | null;
  persistence?: { sessionId?: string | null } | null;
};

const count = (n: unknown): number | undefined => Number.isSafeInteger(n) && (n as number) >= 0 ? n as number : undefined;
const identifier = (s: unknown): s is string => typeof s === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(s);
const date = (value: unknown, fallback: string): string => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fallback;

/** Only counters/settings enter this model. Prompts, messages and tool data are discarded. */
export class CodexTranscriptParser {
  readonly turns = new Map<string, Turn>();
  readonly seen = new Set<string>();
  context: { used: number; max: number } | null = null;
  private current: Turn | null = null;
  private model: string | null = null;
  private tier: string | null = null;
  private retention: string | null = null;

  private turn(id: string, at: string): Turn {
    let turn = this.turns.get(id);
    if (!turn) {
      turn = { id, startedAt: at, endedAt: null, status: 'unknown', model: this.model, requests: [], warnings: new Set() };
      this.turns.set(id, turn);
    }
    this.current = turn;
    return turn;
  }

  accept(line: string, offset = 0): void {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event !== 'object' || !event.payload || typeof event.payload !== 'object') return;
    const p = event.payload;
    const at = date(event.timestamp, '1970-01-01T00:00:00.000Z');
    if (event.type === 'turn_context') {
      if (typeof p.model === 'string') this.model = p.model;
      if ('service_tier' in p) this.tier = typeof p.service_tier === 'string' ? p.service_tier : null;
      if ('prompt_cache_retention' in p) this.retention = typeof p.prompt_cache_retention === 'string' ? p.prompt_cache_retention : null;
      if (typeof p.turn_id === 'string') this.turn(p.turn_id, at).model ??= this.model;
      return;
    }
    if (event.type !== 'event_msg') return;
    if (p.type === 'thread_settings_applied' && p.thread_settings) {
      const settings = p.thread_settings;
      if (typeof settings.model === 'string') this.model = settings.model;
      if ('service_tier' in settings) this.tier = typeof settings.service_tier === 'string' ? settings.service_tier : null;
      if ('prompt_cache_retention' in settings) this.retention = typeof settings.prompt_cache_retention === 'string' ? settings.prompt_cache_retention : null;
      return;
    }
    if (p.type === 'model_rerouted') {
      if (typeof (p.to_model ?? p.toModel) === 'string') this.model = p.to_model ?? p.toModel;
      return;
    }
    if (p.type === 'task_started' && typeof p.turn_id === 'string') {
      this.turn(p.turn_id, date(p.started_at, at));
      return;
    }
    if (['task_complete', 'task_completed', 'turn_aborted'].includes(p.type)) {
      const turn = typeof p.turn_id === 'string' ? this.turn(p.turn_id, date(p.started_at, at)) : this.current;
      if (turn) {
        turn.endedAt = date(p.completed_at, at);
        turn.status = p.type === 'turn_aborted' ? 'canceled' : 'completed';
      }
      return;
    }
    if (p.type !== 'token_count' || !p.info || !this.current) return;
    const info = p.info;
    const last = info.last_token_usage;
    if (!last || typeof last !== 'object') return;
    const input = count(last.input_tokens), cached = count(last.cached_input_tokens), output = count(last.output_tokens);
    const write = count(last.cache_write_input_tokens);
    if (input === undefined || cached === undefined || output === undefined || cached + (write ?? 0) > input) {
      this.current.warnings.add('invalid-token-sample');
      return;
    }
    const total = info.total_token_usage;
    const cumulative = total && [total.input_tokens, total.cached_input_tokens, total.output_tokens].every((n: unknown) => count(n) !== undefined);
    const key = `${this.current.id}:${this.model}:${cumulative ? [total.input_tokens, total.cached_input_tokens, total.output_tokens, total.cache_write_input_tokens ?? ''].join(':') : `offset-${offset}`}`;
    // Replayed snapshots retain their cumulative counter. Distinct equal-sized
    // calls advance it, so both are counted. Rewind copies retain the same key.
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (!cumulative) this.current.warnings.add('cumulative-counter-unavailable');
    if (write === undefined) this.current.warnings.add('cache-write-count-unavailable');
    if (this.tier === null) this.current.warnings.add('processing-tier-unknown-standard-assumed');
    if (write && this.retention === null && !legacySessionPricing(this.model ?? '')) this.current.warnings.add('cache-retention-unknown-30m-assumed');
    this.current.requests.push({
      id: key, model: this.model, serviceTier: this.tier, cacheRetention: this.retention,
      input, cached, output, ...(write === undefined ? {} : { cacheWrite: write }),
      ...(count(last.cache_write_12h_input_tokens) === undefined ? {} : { cacheWrite12h: count(last.cache_write_12h_input_tokens) }),
    });
    const used = count(last.total_tokens) ?? input + output;
    const max = count(info.model_context_window);
    if (max) this.context = { used, max };
  }

  records(agent: AccountingAgent, threadId: string, sessionId: string): { records: TurnRecord[]; active: TurnRecord | null } {
    const records: TurnRecord[] = [];
    let active: TurnRecord | null = null;
    // GPT-5.5's published long-context rule covers its full session. Newer
    // models use per-request thresholds; never apply this to their turn sums.
    const legacyLong = [...this.turns.values()].some(turn => turn.requests.some(request => legacySessionPricing(request.model ?? '') && (request.input ?? 0) > 272000));
    for (const turn of this.turns.values()) {
      if (!turn.requests.length) continue;
      const sum = (key: 'input' | 'cached' | 'output' | 'cacheWrite') => turn.requests.reduce((n, r) => n + (r[key] ?? 0), 0);
      const writesKnown = turn.requests.every(r => r.cacheWrite !== undefined);
      const tiers = new Set(turn.requests.map(r => r.serviceTier));
      const record: TurnRecord = {
        v: 1, id: `codex:${threadId}:${turn.id}`, agentId: agent.id, provider: agent.provider,
        turnId: turn.id, nativeTurnId: turn.id, nativeSessionId: threadId, sessionId,
        model: turn.requests[0].model ?? turn.model ?? agent.model ?? null,
        serviceTier: tiers.size === 1 ? turn.requests[0].serviceTier : null,
        startedAt: turn.startedAt, endedAt: turn.endedAt ?? turn.startedAt,
        durationMs: turn.endedAt ? Math.max(0, Date.parse(turn.endedAt) - Date.parse(turn.startedAt)) : null,
        status: turn.status, input: sum('input'), cached: sum('cached'), output: sum('output'),
        ...(writesKnown ? { cacheWrite: sum('cacheWrite') } : {}),
        requests: turn.requests.map(request => legacySessionPricing(request.model ?? '') && legacyLong ? { ...request, sessionLongContext: true } : request), modelCalls: turn.requests.length,
        accountingWarnings: [...turn.warnings],
        quality: turn.warnings.size ? 'partial' : 'exact', source: 'codex_transcript',
        costUsd: null, sessionCostUsd: null, costScope: 'unknown',
      };
      if (turn.endedAt) records.push(record);
      else active = record;
    }
    return { records: records.slice(-2000), active };
  }
}

/** Incremental reads are serialized; incomplete JSONL tails wait for the next append. */
class TranscriptFile {
  parser = new CodexTranscriptParser();
  private offset = 0;
  private pending: Buffer = Buffer.alloc(0);
  private dropping = false;
  private identity = '';
  private modified = 0;
  private queue: Promise<void> = Promise.resolve();
  read(file: string): Promise<void> {
    const read = this.queue.then(async () => {
      const info = await stat(file);
      const identity = `${info.dev}:${info.ino}`;
      if (this.identity !== identity || info.size < this.offset || info.size === this.offset && info.mtimeMs !== this.modified) {
        this.parser = new CodexTranscriptParser(); this.offset = 0; this.pending = Buffer.alloc(0); this.dropping = false;
      }
      this.identity = identity; this.modified = info.mtimeMs;
      if (info.size <= this.offset) return;
      for await (const chunk of createReadStream(file, { start: this.offset, end: info.size - 1 })) {
        this.offset += chunk.length;
        this.pending = Buffer.concat([this.pending, chunk]);
        let end: number;
        while ((end = this.pending.indexOf(10)) !== -1) {
          if (!this.dropping) this.parser.accept(this.pending.subarray(0, end).toString('utf8'), this.offset - this.pending.length);
          this.pending = this.pending.subarray(end + 1); this.dropping = false;
        }
        // Large message payloads are irrelevant; never accumulate them in memory.
        if (this.pending.length > 4 * 1024 * 1024) { this.pending = Buffer.alloc(0); this.dropping = true; }
      }
    });
    this.queue = read.catch(() => {});
    return read;
  }
}

type Provider = { extends?: string; env?: Record<string, string> };
export class CodexTranscripts {
  private readonly agents = new Map<string, AccountingAgent>();
  private readonly files = new Map<string, TranscriptFile>();
  private readonly indices = new Map<string, { at: number; promise: Promise<Map<string, string>> }>();
  private config: { at: number; providers: Record<string, Provider> } | null = null;
  private readonly home: string;
  constructor(home = process.env.PASEO_HOME ?? join(homedir(), '.paseo')) { this.home = home; }

  note(agent: AccountingAgent): void { this.agents.set(agent.id, agent); }
  has(agentId: string): boolean { return this.agents.has(agentId); }
  ids(): string[] { return [...this.agents.keys()]; }
  sessionId(agentId: string): string | null {
    const agent = this.agents.get(agentId);
    return agent?.runtimeInfo?.sessionId ?? agent?.persistence?.sessionId ?? null;
  }

  private async providerHome(provider: string): Promise<string | null> {
    if (!this.config || Date.now() - this.config.at > 30_000) {
      let providers: Record<string, Provider> = {};
      try { providers = JSON.parse(await readFile(join(this.home, 'config.json'), 'utf8')).agents?.providers ?? {}; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      this.config = { at: Date.now(), providers };
    }
    let id = provider; let root: string | undefined; const visited = new Set<string>();
    while (id && !visited.has(id)) {
      visited.add(id);
      const entry = this.config.providers[id];
      root ??= entry?.env?.CODEX_HOME;
      if (id === 'codex' || !entry?.extends) break;
      id = entry.extends;
    }
    if (id !== 'codex' && root === undefined) return null;
    root ??= process.env.CODEX_HOME ?? join(homedir(), '.codex');
    root = root.replace(/^~(?=\/|$)/, homedir());
    return isAbsolute(root) ? root : resolve(this.home, root);
  }

  private index(home: string, refresh = false): Promise<Map<string, string>> {
    const cached = this.indices.get(home);
    if (cached && !refresh && Date.now() - cached.at < 15_000) return cached.promise;
    const promise = (async () => {
      const paths = new Map<string, string>();
      const walk = async (directory: string, depth = 0): Promise<void> => {
        if (depth > 6) return;
        let entries;
        try { entries = await readdir(directory, { withFileTypes: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
        for (const entry of entries) {
          if (entry.isDirectory()) await walk(join(directory, entry.name), depth + 1);
          else if (entry.isFile()) {
            const id = entry.name.match(/([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})\.jsonl$/i)?.[1];
            if (id && !paths.has(id)) paths.set(id, join(directory, entry.name));
          }
        }
      };
      await walk(join(home, 'sessions')); await walk(join(home, 'archived_sessions'));
      return paths;
    })();
    this.indices.set(home, { at: Date.now(), promise });
    void promise.catch(() => { if (this.indices.get(home)?.promise === promise) this.indices.delete(home); });
    return promise;
  }

  async read(agentId: string, sessionOverride?: string): Promise<{ records: TurnRecord[]; active: TurnRecord | null; context: CodexTranscriptParser['context'] } | null> {
    const agent = this.agents.get(agentId);
    const sessionId = sessionOverride ?? this.sessionId(agentId);
    if (!agent || !identifier(sessionId)) return null;
    const home = await this.providerHome(agent.provider);
    if (!home) return null;
    let threadId = sessionId;
    // Our ACP adapter persists its actual Codex thread handle separately.
    // A missing map simply leaves the native session id unchanged.
    try {
      const mapping = JSON.parse(await readFile(join(home, 'paseo-usage', sessionId + '.json'), 'utf8'));
      if (identifier(mapping.threadId)) threadId = mapping.threadId;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    let path = (await this.index(home)).get(threadId);
    if (!path && Date.now() - (this.indices.get(home)?.at ?? 0) > 1000) path = (await this.index(home, true)).get(threadId);
    if (!path) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let file = this.files.get(path);
      if (!file) { file = new TranscriptFile(); this.files.set(path, file); }
      try {
        await file.read(path);
        return { ...file.parser.records(agent, threadId, sessionId), context: file.parser.context };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // Archiving/restoring moves the log while the directory index is cached.
        // Re-resolve once; a temporarily missing log must not erase saved usage.
        this.files.delete(path);
        if (attempt === 1) return null;
        path = (await this.index(home, true)).get(threadId);
        if (!path) return null;
      }
    }
    return null;
  }
}

export function overlaps(a: TurnRecord, b: TurnRecord): boolean {
  if (a.agentId !== b.agentId || a.sessionId !== b.sessionId) return false;
  if (a.nativeTurnId && b.nativeTurnId) return a.nativeTurnId === b.nativeTurnId;
  const startA = Date.parse(a.startedAt ?? a.endedAt), startB = Date.parse(b.startedAt ?? b.endedAt);
  return startA <= Date.parse(b.endedAt) && startB <= Date.parse(a.endedAt);
}
