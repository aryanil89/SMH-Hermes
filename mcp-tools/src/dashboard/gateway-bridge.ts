/**
 * Phone -> server messages, taken from the Hermes gateway's own transcript.
 *
 * ## Why this exists
 *
 * The wall could always show what the *server sent* -- the cron watchdog's pages
 * and the access sentry's challenges both leave evidence the panel can mirror.
 * What the *phone sent* had no source at all, so the thread was one-directional
 * and the panel had to say "outbound only" to stay honest.
 *
 * The obvious fix -- poll Telegram -- is the one thing this system must not do.
 * `getUpdates` is single-consumer per bot token and `hermes gateway` long-polls
 * that token for the whole demo; a second consumer gets a 409 and the two starve
 * each other (see telegram-poll.ts). A display that breaks the thing it depicts
 * is the worst failure available here.
 *
 * So read what the gateway already wrote down. Hermes keeps a durable transcript
 * in `%LOCALAPPDATA%\hermes\state.db`: one row per message, with the role, the
 * verbatim text, the real timestamp, and the session's platform and chat id. The
 * wall opens that file **read-only** and mirrors the Telegram sessions. No
 * polling, no token, no conflict, and both directions come out verbatim rather
 * than reconstructed.
 *
 * ## What is and is not a message
 *
 * The transcript is an agent's working record, not a chat log, so most rows are
 * not things a human ever saw:
 *
 *   - `role='tool'` rows are tool results, and `role='session_meta'` is
 *     bookkeeping. Neither reached the phone.
 *   - An `assistant` row with empty content is a tool-call turn -- the model
 *     deciding to call `get_environmental_status`, not answering anyone.
 *   - Hermes writes internal markers as bracketed text (`[SILENT]`,
 *     `[This response was interrupted by a user correction.]`). Those are control
 *     signals, and rendering one as a delivered reply would put words on the wall
 *     that the on-call never received.
 *
 * What survives that filter is a user message the phone actually sent, or an
 * assistant message the gateway completed and handed to Telegram. Everything else
 * is dropped.
 *
 * One caveat worth stating rather than papering over: the transcript records the
 * turn, not the HTTP result of the send. So a reply row is weaker evidence than
 * the access sentry's pushes, which carry the actual call outcome and render as
 * undelivered when it fails. It is still an observed record of something the
 * gateway produced and sent, which is the standard this panel holds itself to --
 * but it is not proof the phone's radio was on.
 *
 * ## Degrading
 *
 * `node:sqlite` is Node 22.5+, above the package's Node 22 engines floor, so the
 * driver is loaded lazily and a miss is reported as an inbound status rather than
 * thrown. A machine with no Hermes install (anyone who cloned the repo) has no
 * database, which is not an error either -- the panel keeps saying "outbound
 * only" exactly as it did before.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IngestInput, InboundReport } from "./telegram-feed.js";

/** Hermes session sources that represent the on-call's phone. */
const DEFAULT_SOURCES = ["telegram"];
/** Rows per drain. Bounded so a long catch-up cannot stall a 2s tick. */
const DEFAULT_BATCH = 100;
/** Transcript entries shown on attach, so a wall started mid-demo is not blank. */
const DEFAULT_BACKFILL = 8;
/**
 * A bubble is a chat message. Hermes replies run ~1KB, but a runaway generation
 * would otherwise push everything else out of the thread.
 */
const MAX_TEXT = 1500;

/** Internal control markers Hermes stores as bracketed text -- never delivered. */
const INTERNAL_MARKER = /^\[[^\]]*\]$/;

export interface GatewayBridgeOptions {
  dbPath: string;
  /** Recent transcript entries to emit on the first drain. 0 disables backfill. */
  backfill?: number;
  /** Hermes `sessions.source` values to mirror. */
  sources?: string[];
  batchSize?: number;
}

interface TranscriptRow {
  id: number;
  role: string;
  content: string | null;
  /** Unix seconds, float. */
  timestamp: number;
  chat_id: string | null;
}

/**
 * The slice of `node:sqlite` this file uses.
 *
 * Declared locally because the package's `@types/node` is v20, which predates the
 * module -- importing its types would fail the build on the very Node versions
 * that can run it.
 */
interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
type SqliteOpener = (path: string) => SqliteDatabase;

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

/**
 * Load `node:sqlite` at runtime.
 *
 * `process.getBuiltinModule` rather than `import("node:sqlite")` for two
 * reasons: a literal import is resolved at compile time and fails to type-check
 * against the installed @types/node 20 typings (which predate node:sqlite;
 * the runtime engines floor is Node 22), and a variable
 * specifier is rewritten by the test runner's module transform, which drops the
 * `node:` prefix and then cannot find it. This call reaches the real builtin
 * registry from either environment, and answers `undefined` -- not a throw -- on
 * a runtime too old to have the module.
 */
function defaultOpener(): SqliteOpener {
  const get = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  const mod = typeof get === "function" ? (get.call(process, "node:sqlite") as SqliteModule | undefined) : undefined;
  if (!mod?.DatabaseSync) throw new Error("node:sqlite is unavailable");
  return (path: string) => new mod.DatabaseSync(path, { readOnly: true });
}

export class HermesGatewayBridge {
  private db: SqliteDatabase | undefined;
  private opener: SqliteOpener | undefined;
  private lastId = 0;
  private attached = false;
  private status: InboundReport;
  private readonly sources: string[];
  private readonly batchSize: number;
  private readonly backfill: number;

  constructor(
    private readonly opts: GatewayBridgeOptions,
    /** Injected by the tests; production loads `node:sqlite` lazily. */
    private readonly loadOpener: () => SqliteOpener = defaultOpener,
  ) {
    this.sources = opts.sources ?? DEFAULT_SOURCES;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH;
    this.backfill = opts.backfill ?? DEFAULT_BACKFILL;
    this.status = {
      mode: "starting",
      detail: `reading the Hermes gateway transcript at ${opts.dbPath}`,
      bot: "gateway",
    };
  }

  getStatus(): InboundReport {
    return { ...this.status };
  }

  /**
   * New phone traffic since the last call, oldest first.
   *
   * Never throws. The transcript is a file another process is writing to; a
   * locked read is an ordinary event on Windows and must not take down the tick
   * loop that also drives the sensor feed and the access sentry.
   */
  async drain(): Promise<IngestInput[]> {
    let db: SqliteDatabase;
    try {
      db = this.open();
    } catch (err) {
      this.status = {
        mode: "error",
        detail: describeOpenFailure(err, this.opts.dbPath),
        bot: "gateway",
      };
      return [];
    }

    try {
      const head = this.headId(db);
      const first = !this.attached;
      this.attached = true;

      const rows = first ? this.readBackfill(db) : this.readSince(db, head);
      if (first) this.lastId = head;

      this.status = {
        mode: "live",
        detail: `mirroring the Hermes gateway transcript (${this.opts.dbPath})`,
        bot: "gateway",
      };
      return rows.map(toIngest).filter((m): m is IngestInput => m !== undefined);
    } catch (err) {
      // A rollback-journal database can hand a reader SQLITE_BUSY mid-write.
      // Drop the handle so the next tick reopens cleanly, and say so on the panel
      // instead of silently showing a thread that stopped updating.
      this.close();
      this.status = {
        mode: "error",
        detail: `could not read the Hermes transcript: ${message(err)}`,
        bot: "gateway",
      };
      return [];
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // Closing a handle whose file went away is not worth reporting.
    }
    this.db = undefined;
  }

  private open(): SqliteDatabase {
    if (this.db) return this.db;
    this.opener ??= this.loadOpener();
    this.db = this.opener(this.opts.dbPath);
    return this.db;
  }

  /** Highest row id in the table, captured *before* a read so nothing is skipped. */
  private headId(db: SqliteDatabase): number {
    const row = db.prepare("SELECT MAX(id) AS head FROM messages").get() as
      | { head: number | null }
      | undefined;
    return row?.head ?? 0;
  }

  /**
   * The last few entries of the thread, so a wall opened mid-demo shows the
   * conversation already in progress.
   *
   * Honest because these carry their real timestamps: the panel prints the time
   * on every bubble, so a backfilled message reads as the historical entry it is
   * rather than as something that just arrived.
   */
  private readBackfill(db: SqliteDatabase): TranscriptRow[] {
    if (this.backfill <= 0) return [];
    const rows = db
      .prepare(
        `SELECT m.id, m.role, m.content, m.timestamp, s.chat_id
           FROM messages m JOIN sessions s ON s.id = m.session_id
          WHERE s.source IN (${this.placeholders()}) AND m.role IN ('user', 'assistant')
          ORDER BY m.id DESC
          LIMIT ?`,
      )
      .all(...this.sources, this.backfill * 4) as TranscriptRow[];
    // Over-fetched because most assistant rows are tool-call turns that the
    // filter drops; trim to the requested count after filtering, oldest first.
    const usable = rows.filter((row) => toIngest(row) !== undefined);
    return usable.slice(0, this.backfill).reverse();
  }

  private readSince(db: SqliteDatabase, head: number): TranscriptRow[] {
    const rows = db
      .prepare(
        `SELECT m.id, m.role, m.content, m.timestamp, s.chat_id
           FROM messages m JOIN sessions s ON s.id = m.session_id
          WHERE m.id > ? AND s.source IN (${this.placeholders()}) AND m.role IN ('user', 'assistant')
          ORDER BY m.id ASC
          LIMIT ?`,
      )
      .all(this.lastId, ...this.sources, this.batchSize) as TranscriptRow[];

    if (rows.length >= this.batchSize) {
      // More to come; resume from the last row rather than the table head.
      this.lastId = rows[rows.length - 1]?.id ?? this.lastId;
    } else {
      // Everything up to `head` has been seen. Advancing to the head -- not just
      // to the last *matching* row -- stops a long run of tool rows from being
      // rescanned on every 2s tick for the rest of the demo.
      this.lastId = Math.max(this.lastId, head);
    }
    return rows;
  }

  private placeholders(): string {
    return this.sources.map(() => "?").join(", ");
  }
}

/**
 * One transcript row -> one bubble, or nothing.
 *
 * Returning `undefined` is the common case: most rows in an agent transcript are
 * tool traffic or control markers that never reached a phone.
 */
function toIngest(row: TranscriptRow): IngestInput | undefined {
  const text = (row.content ?? "").trim();
  if (text === "") return undefined;
  if (INTERNAL_MARKER.test(text)) return undefined;
  if (text.startsWith("<untrusted_tool_result")) return undefined;
  if (row.role !== "user" && row.role !== "assistant") return undefined;

  const at = Number.isFinite(row.timestamp)
    ? new Date(row.timestamp * 1000).toISOString()
    : new Date().toISOString();

  return {
    direction: row.role === "user" ? "inbound" : "outbound",
    kind: row.role === "user" ? "question" : "reply",
    text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}… [truncated for display]` : text,
    at,
  };
}

/**
 * Where the Hermes transcript lives, or undefined when there is no Hermes here.
 *
 * `HERMES_HOME` is what the agent itself reads, so following it keeps the wall
 * pointed at the same install even on a non-default layout.
 */
export function resolveHermesStateDb(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.HERMES_BRIDGE === "0") return undefined;

  // An explicit path is returned even when it is not there. Someone who set
  // HERMES_STATE_DB wants that file mirrored, and a typo should surface as
  // "could not open …" on the panel rather than as a thread that is quietly and
  // inexplicably one-directional.
  const explicit = env.HERMES_STATE_DB?.trim();
  if (explicit) return explicit;

  const candidates: string[] = [];
  const home = env.HERMES_HOME?.trim();
  if (home) candidates.push(join(home, "state.db"));
  if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, "hermes", "state.db"));
  candidates.push(join(homedir(), "AppData", "Local", "hermes", "state.db"));
  candidates.push(join(homedir(), ".local", "share", "hermes", "state.db"));
  candidates.push(join(homedir(), ".hermes", "state.db"));

  return candidates.find((path) => existsSync(path));
}

/**
 * Merge the two possible inbound sources into one panel status.
 *
 * Both can be configured at once -- the bridge mirrors the agent's own bot while
 * the poller watches a separate wall bot -- so the panel reports the best state
 * either of them is in. "Live" wins, because from the viewer's side the question
 * is only ever "can a message from the phone reach this panel".
 */
export function mergeInbound(...reports: (InboundReport | undefined)[]): InboundReport | undefined {
  const present = reports.filter((r): r is InboundReport => r !== undefined);
  if (present.length === 0) return undefined;
  const rank: Record<string, number> = { live: 4, starting: 3, error: 2, conflict: 1, off: 0 };
  return present.reduce((best, next) =>
    (rank[next.mode] ?? 0) > (rank[best.mode] ?? 0) ? next : best,
  );
}

function describeOpenFailure(err: unknown, dbPath: string): string {
  const detail = message(err);
  if (detail.includes("Cannot find module") || detail.includes("node:sqlite")) {
    return (
      "the Hermes transcript bridge needs Node 22.5+ for node:sqlite " +
      `(this process is ${process.version}). Phone → server messages will not appear.`
    );
  }
  return `could not open the Hermes transcript at ${dbPath}: ${detail}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
