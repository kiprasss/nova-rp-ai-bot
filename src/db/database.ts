import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export type Param = string | number | null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS guilds (
  guild_id TEXT PRIMARY KEY,
  category_id TEXT,
  assistant_channel_id TEXT,
  settings_channel_id TEXT,
  logs_channel_id TEXT,
  settings_message_id TEXT,
  ai_provider TEXT,
  ai_model TEXT,
  ai_token TEXT,
  refresh_hours INTEGER NOT NULL DEFAULT 12,
  last_refresh_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS role_perms (
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  can_ask INTEGER NOT NULL DEFAULT 1,
  any_channel INTEGER NOT NULL DEFAULT 0,
  manage_sources INTEGER NOT NULL DEFAULT 0,
  manage_ai INTEGER NOT NULL DEFAULT 0,
  view_logs INTEGER NOT NULL DEFAULT 0,
  hourly_limit INTEGER NOT NULL DEFAULT 10,
  PRIMARY KEY (guild_id, role_id)
);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  url TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT,
  added_by TEXT,
  added_at INTEGER NOT NULL,
  last_fetched_at INTEGER,
  last_error TEXT,
  UNIQUE (scope, url)
);

CREATE TABLE IF NOT EXISTS documents (
  url TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT,
  breadcrumbs TEXT,
  is_rules INTEGER NOT NULL DEFAULT 0,
  is_complaint INTEGER NOT NULL DEFAULT 0,
  last_post_ts INTEGER,
  content_hash TEXT,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS source_docs (
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  doc_url TEXT NOT NULL REFERENCES documents(url) ON DELETE CASCADE,
  PRIMARY KEY (source_id, doc_url)
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_url TEXT NOT NULL REFERENCES documents(url) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  post_url TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_url);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_url TEXT NOT NULL REFERENCES documents(url) ON DELETE CASCADE,
  post_url TEXT NOT NULL,
  point TEXT NOT NULL,
  text TEXT NOT NULL,
  punishment TEXT,
  repeat_warn INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS rules_point ON rules(point);

CREATE TABLE IF NOT EXISTS faq (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  keywords TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  answer_length TEXT NOT NULL DEFAULT 'short',
  show_sources INTEGER NOT NULL DEFAULT 1,
  ai_provider TEXT,
  ai_model TEXT,
  ai_token TEXT
);

CREATE TABLE IF NOT EXISTS ai_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ok INTEGER NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_requests_guild ON ai_requests(guild_id, ts);

CREATE TABLE IF NOT EXISTS rule_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_url TEXT NOT NULL,
  doc_title TEXT NOT NULL,
  kind TEXT NOT NULL,
  point TEXT,
  before_text TEXT,
  before_punishment TEXT,
  after_text TEXT,
  after_punishment TEXT,
  post_url TEXT,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS player_ids (
  game_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS player_ids_user ON player_ids(user_id);

CREATE TABLE IF NOT EXISTS complaint_threads (
  url TEXT PRIMARY KEY,
  offender_id TEXT,
  title TEXT NOT NULL,
  prefix TEXT,
  last_post_ts INTEGER,
  first_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS complaint_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  offender_id TEXT NOT NULL,
  title TEXT NOT NULL,
  prefix TEXT,
  kind TEXT NOT NULL,
  dm_sent INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT,
  ts INTEGER NOT NULL
);
`;

let db: DatabaseSync | null = null;
const stmtCache = new Map<string, StatementSync>();

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  stmtCache.clear();
  return db;
}

/** Добавляет новые колонки в базы, созданные старыми версиями бота. */
function migrate(d: DatabaseSync): void {
  const add: Record<string, [string, string][]> = {
    guilds: [
      ['rules_channel_id', 'TEXT'],
      ['last_rule_event_id', 'INTEGER NOT NULL DEFAULT 0'],
      ['ai_answer_length', "TEXT NOT NULL DEFAULT 'short'"],
      ['ai_temperature', 'REAL'],
      ['ai_rewrite', 'INTEGER NOT NULL DEFAULT 1'],
      ['ai_show_sources', 'INTEGER NOT NULL DEFAULT 1'],
      ['ai_context_size', 'INTEGER NOT NULL DEFAULT 6'],
      ['ai_instructions', 'TEXT'],
      ['ai_tone', "TEXT NOT NULL DEFAULT 'neutral'"],
      ['ai_max_tokens', 'INTEGER'],
      ['ai_fallback_model', 'TEXT'],
      ['ai_search_complaints', 'INTEGER NOT NULL DEFAULT 1'],
      ['ai_auto_reply', 'INTEGER NOT NULL DEFAULT 1'],
      ['ai_threads', 'INTEGER NOT NULL DEFAULT 0'],
      ['ai_show_model', 'INTEGER NOT NULL DEFAULT 0'],
      ['ai_faq_first', 'INTEGER NOT NULL DEFAULT 1'],
      ['ai_forum_only', 'INTEGER NOT NULL DEFAULT 0'],
      ['ai_log_thoughts', 'INTEGER NOT NULL DEFAULT 0'],
      ['complaints_channel_id', 'TEXT'],
      ['last_complaint_event_id', 'INTEGER NOT NULL DEFAULT 0'],
    ],
    user_settings: [['complaint_dm', 'INTEGER NOT NULL DEFAULT 1']],
    complaint_threads: [
      ['author', 'TEXT'],
      ['offender_nick', 'TEXT'],
    ],
    role_perms: [
      ['dm_access', 'INTEGER NOT NULL DEFAULT 1'],
      ['see_channels', 'INTEGER NOT NULL DEFAULT 1'],
      ['can_write', 'INTEGER NOT NULL DEFAULT 1'],
      ['see_settings', 'INTEGER NOT NULL DEFAULT 0'],
      ['blocked_commands', "TEXT NOT NULL DEFAULT ''"],
      ['max_player_ids', 'INTEGER NOT NULL DEFAULT 3'],
    ],
  };
  for (const [table, cols] of Object.entries(add)) {
    const existing = new Set((d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    for (const [name, type] of cols) {
      if (!existing.has(name)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
  migrateForumHost(d);
}

/** Форум переехал с forum.grand-rp.su на forum.nova-rp.com (номера тем и разделов те же). */
export const LEGACY_FORUM_HOST = 'forum.grand-rp.su';
export const FORUM_HOST = 'forum.nova-rp.com';

/**
 * Переписывает ссылки старого форума во всех текстовых колонках и удаляет заглушки «Форум переехал»,
 * скачанные со старого адреса (в них нет текста — после переезда темы скачаются заново).
 */
function migrateForumHost(d: DatabaseSync): void {
  const tables = (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {
    name: string;
  }[]).map((t) => t.name);
  const targets: [string, string][] = [];
  for (const t of tables) {
    for (const c of d.prepare(`PRAGMA table_info(${t})`).all() as { name: string; type: string }[]) {
      if (!/TEXT/i.test(c.type)) continue;
      const hit = d.prepare(`SELECT 1 FROM ${t} WHERE ${c.name} LIKE ? LIMIT 1`).get(`%${LEGACY_FORUM_HOST}%`);
      if (hit) targets.push([t, c.name]);
    }
  }
  if (!targets.length) return;
  // Ссылки — ключи и внешние ключи (documents.url ← chunks.doc_url …): меняем всё разом с выключенными FK.
  d.exec('PRAGMA foreign_keys = OFF');
  try {
    d.exec('BEGIN');
    d.prepare("DELETE FROM chunks WHERE doc_url IN (SELECT url FROM documents WHERE title = 'Форум переехал — NOVA RP')").run();
    d.prepare("DELETE FROM source_docs WHERE doc_url IN (SELECT url FROM documents WHERE title = 'Форум переехал — NOVA RP')").run();
    d.prepare("DELETE FROM documents WHERE title = 'Форум переехал — NOVA RP'").run();
    for (const [t, c] of targets) {
      d.prepare(`UPDATE ${t} SET ${c} = replace(${c}, ?, ?) WHERE ${c} LIKE ?`).run(
        LEGACY_FORUM_HOST,
        FORUM_HOST,
        `%${LEGACY_FORUM_HOST}%`,
      );
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  } finally {
    d.exec('PRAGMA foreign_keys = ON');
  }
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('База данных не открыта');
  return db;
}

function stmt(sql: string): StatementSync {
  let s = stmtCache.get(sql);
  if (!s) {
    s = getDb().prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

export function all<T>(sql: string, ...params: Param[]): T[] {
  return stmt(sql).all(...params) as unknown as T[];
}

export function get<T>(sql: string, ...params: Param[]): T | undefined {
  return stmt(sql).get(...params) as unknown as T | undefined;
}

export function run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
  const r = stmt(sql).run(...params);
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

export function transaction<T>(fn: () => T): T {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const result = fn();
    d.exec('COMMIT');
    return result;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}
