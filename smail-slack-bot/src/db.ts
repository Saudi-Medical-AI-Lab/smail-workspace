import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type JobState = "queued" | "parsing" | "awaiting_confirm" | "awaiting_approval" | "merging" | "live" | "declined" | "failed" | "expired";
export interface Job {
  id: string; state: JobState; channel: string; thread_ts: string; requester: string; text: string;
  branch: string | null; slug: string | null; pr: number | null; summary: string | null; kind: "edit" | "undo";
  message_ts: string | null; created_at: number; error: string | null;
  ops: string | null; files: string | null; // parsed operations and Slack file urls, kept while waiting for the user to confirm
}

const UPDATABLE = new Set(["state", "channel", "thread_ts", "requester", "text", "branch", "slug", "pr", "summary", "kind", "message_ts", "error", "ops", "files"]);

export function openDb(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS seen_events (event_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, state TEXT NOT NULL, channel TEXT NOT NULL, thread_ts TEXT NOT NULL, requester TEXT NOT NULL,
      text TEXT NOT NULL, branch TEXT, slug TEXT, pr INTEGER, summary TEXT, kind TEXT NOT NULL DEFAULT 'edit',
      message_ts TEXT, created_at INTEGER NOT NULL, error TEXT
    );
    CREATE TABLE IF NOT EXISTS audit (at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, job_id TEXT, detail TEXT);
    CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
  for (const col of ['ops TEXT', 'files TEXT']) { try { db.exec(`ALTER TABLE jobs ADD COLUMN ${col}`); } catch { /* already there */ } }
  const now = () => Date.now();
  return {
    /** true if this id is new (process it); false if Slack already delivered it. */
    firstSeen(id: string): boolean {
      db.prepare("DELETE FROM seen_events WHERE at < ?").run(now() - 24 * 3600_000);
      return db.prepare("INSERT OR IGNORE INTO seen_events VALUES (?, ?)").run(id, now()).changes === 1;
    },
    createJob(j: Pick<Job, "id" | "channel" | "thread_ts" | "requester" | "text" | "kind">) {
      db.prepare("INSERT INTO jobs (id,state,channel,thread_ts,requester,text,kind,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(j.id, "queued", j.channel, j.thread_ts, j.requester, j.text, j.kind, now());
    },
    getJob: (id: string) => db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job | undefined,
    update(id: string, patch: Partial<Omit<Job, "id">>) {
      const keys = Object.keys(patch);
      if (!keys.length) return;
      // Column names cannot be bound as parameters, so they must come from a fixed list (values are always bound).
      const bad = keys.find((k) => !UPDATABLE.has(k));
      if (bad) throw new Error(`Not an updatable column: ${bad}`);
      db.prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`).run({ ...patch, id });
    },
    /** Atomically claims a state transition so a double click cannot approve twice. */
    transition(id: string, from: JobState, to: JobState): boolean {
      return db.prepare("UPDATE jobs SET state = ? WHERE id = ? AND state = ?").run(to, id, from).changes === 1;
    },
    nextQueued: () => db.prepare("SELECT * FROM jobs WHERE state = 'queued' ORDER BY created_at LIMIT 1").get() as Job | undefined,
    stuck: (state: JobState) => db.prepare("SELECT * FROM jobs WHERE state = ?").all(state) as Job[],
    waitingConfirm: () => db.prepare("SELECT * FROM jobs WHERE state = 'awaiting_confirm'").all() as Job[],
    awaiting: () => db.prepare("SELECT * FROM jobs WHERE state = 'awaiting_approval'").all() as Job[],
    audit(actor: string, action: string, jobId?: string, detail?: string) {
      db.prepare("INSERT INTO audit VALUES (?,?,?,?,?)").run(now(), actor, action, jobId ?? null, detail ?? null);
    },
    get paused() { return (db.prepare("SELECT v FROM settings WHERE k='paused'").get() as any)?.v === "1"; },
    setPaused(p: boolean) { db.prepare("INSERT INTO settings VALUES ('paused', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(p ? "1" : "0"); },
    close: () => db.close(),
  };
}
export type Db = ReturnType<typeof openDb>;
