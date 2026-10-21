import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { TurnRecordSchema, type TurnRecord } from "../shared/ledger.ts";
import { overlaps } from './codex-transcripts.ts';

const DATA_DIR = join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugins", "token-ledger-canary");
const DATA_FILE = join(DATA_DIR, "ledger.jsonl");
const MAX_RECORDS = 2000;
const TRIM_THRESHOLD = 2200;

let records: TurnRecord[] = [];
let loadPromise: Promise<void> | null = null;
let writeQueue: Promise<void> = Promise.resolve();
const ids = new Set<string>();
const bootId = crypto.randomUUID();
let revision = 0;
export const storeRevision = () => `${bootId}:${revision}`;

export function dataFilePath(): string {
  return DATA_FILE;
}

export function loadStore(): Promise<void> {
  loadPromise ??= (async () => {
    let text: string;
    try {
      text = await readFile(DATA_FILE, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = TurnRecordSchema.parse(JSON.parse(trimmed));
        records.push(record);
        ids.add(record.id);
      } catch {
        // skip corrupt lines rather than losing the whole ledger
      }
    }
  })().catch((error) => { loadPromise = null; throw error; });
  return loadPromise;
}

export function appendRecord(record: TurnRecord): Promise<void> {
  const write = writeQueue.then(async () => {
    await loadStore();
    if (ids.has(record.id)) return;
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(DATA_FILE, `${JSON.stringify(record)}\n`, "utf8");
    records.push(record);
    ids.add(record.id);
    revision++;
    if (records.length > TRIM_THRESHOLD) {
      const retained = records.slice(-MAX_RECORDS);
      const tmp = `${DATA_FILE}.tmp`;
      await writeFile(tmp, `${retained.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
      await rename(tmp, DATA_FILE);
      records = retained;
    }
  });
  // Keep the queue usable after a failed write; the caller still sees failure.
  writeQueue = write.catch(() => undefined);
  return write;
}

export function flushStore(): Promise<void> { return writeQueue; }

/** Replace overlapping telemetry with stable, recoverable native turn records. */
export function upsertTranscriptRecords(incoming: TurnRecord[]): Promise<void> {
  if (!incoming.length) return Promise.resolve();
  const write = writeQueue.then(async () => {
    await loadStore();
    const additions = new Map(incoming.map(record => [record.id, record]));
    // The same native thread can be attached to multiple catalog agents. Keep
    // one owner for an existing request identity rather than counting it twice.
    for (const record of records) {
      const next = additions.get(record.id);
      if (next && next.agentId !== record.agentId) additions.set(record.id, record);
    }
    const merged = records.filter(record => !additions.has(record.id)
      && !(record.source !== 'codex_transcript' && incoming.some(next => overlaps(record, next))));
    merged.push(...additions.values());
    merged.sort((a, b) => a.endedAt.localeCompare(b.endedAt) || a.id.localeCompare(b.id));
    const retained = merged.slice(-MAX_RECORDS);
    if (JSON.stringify(retained) === JSON.stringify(records)) return;
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    await writeFile(tmp, retained.map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8');
    await rename(tmp, DATA_FILE);
    records = retained; ids.clear();
    for (const record of retained) ids.add(record.id);
    revision++;
  });
  writeQueue = write.catch(() => undefined);
  return write;
}

/** Newest first. */
export function recordsForAgent(agentId: string, limit: number): TurnRecord[] {
  const matching: TurnRecord[] = [];
  for (let i = records.length - 1; i >= 0 && matching.length < limit; i--) {
    if (records[i].agentId === agentId) matching.push(records[i]);
  }
  return matching;
}

export function lastRecordForAgent(agentId: string): TurnRecord | null {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].agentId === agentId) return records[i];
  }
  return null;
}

export function allRecords(): readonly TurnRecord[] {
  return records;
}

