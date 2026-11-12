import { config } from '../config.js';
import { all, get, run, transaction, type Param } from './database.js';

export const GLOBAL_SCOPE = 'global';

// ---------- Типы ----------

export interface GuildRow {
  guild_id: string;
  category_id: string | null;
  assistant_channel_id: string | null;
  settings_channel_id: string | null;
  logs_channel_id: string | null;
  rules_channel_id: string | null;
  last_rule_event_id: number;
  /** Настройки AI сервера (меню «Настройки AI»). */
  ai_answer_length: 'short' | 'long';
  ai_temperature: number | null;
  ai_rewrite: number;
  ai_show_sources: number;
  ai_context_size: number;
  ai_instructions: string | null;
  ai_tone: 'neutral' | 'official' | 'friendly' | 'strict';
  ai_max_tokens: number | null;
  ai_fallback_model: string | null;
  ai_search_complaints: number;
  ai_auto_reply: number;
  ai_threads: number;
  ai_show_model: number;
  ai_faq_first: number;
  /** 1 — «Только форум»: без болтовни и общих знаний, ответ только по найденным фрагментам. */
  ai_forum_only: number;
  complaints_channel_id: string | null;
  last_complaint_event_id: number;
  settings_message_id: string | null;
  ai_provider: string | null;
  ai_model: string | null;
  ai_token: string | null;
  refresh_hours: number;
  last_refresh_at: number | null;
  created_at: number;
}

export interface RolePerm {
  guild_id: string;
  role_id: string;
  can_ask: number;
  any_channel: number;
  manage_sources: number;
  manage_ai: number;
  view_logs: number;
  hourly_limit: number;
  dm_access: number;
  see_channels: number;
  can_write: number;
  see_settings: number;
  /** Запрещённые команды через запятую, например «жалоба,faq». */
  blocked_commands: string;
  /** Сколько игровых ID можно привязать (/мой-id), 0 — без лимита. */
  max_player_ids: number;
}

/** Права, связанные с AI и настройками. */
export type PermFlag = 'can_ask' | 'any_channel' | 'manage_sources' | 'manage_ai' | 'view_logs';
export const PERM_FLAGS: PermFlag[] = ['can_ask', 'any_channel', 'manage_sources', 'manage_ai', 'view_logs'];

/** Доступ к каналам бота и к ЛС. */
export type AccessFlag = 'see_channels' | 'can_write' | 'see_settings' | 'dm_access';
export const ACCESS_FLAGS: AccessFlag[] = ['see_channels', 'can_write', 'see_settings', 'dm_access'];

/** Команды, которые можно запретить роли. /setup всегда только для администраторов. */
export const BOT_COMMANDS = ['вопрос', 'правило', 'наказание', 'жалоба', 'faq', 'помощь', 'setupls', 'мой-id'] as const;

export function newRolePerm(guildId: string, roleId: string, defaultLimit: number, patch: Partial<RolePerm> = {}): RolePerm {
  return {
    guild_id: guildId,
    role_id: roleId,
    can_ask: 1,
    any_channel: 0,
    manage_sources: 0,
    manage_ai: 0,
    view_logs: 0,
    hourly_limit: defaultLimit,
    dm_access: 1,
    see_channels: 1,
    can_write: 1,
    see_settings: 0,
    blocked_commands: '',
    max_player_ids: DEFAULT_MAX_IDS_PER_USER,
    ...patch,
  };
}

export function blockedCommandsOf(p: RolePerm): Set<string> {
  return new Set(p.blocked_commands.split(',').map((c) => c.trim()).filter(Boolean));
}

export interface SourceRow {
  id: number;
  scope: string;
  url: string;
  kind: 'thread' | 'forum';
  title: string | null;
  added_by: string | null;
  added_at: number;
  last_fetched_at: number | null;
  last_error: string | null;
}

export interface DocumentRow {
  url: string;
  title: string;
  author: string | null;
  breadcrumbs: string | null;
  is_rules: number;
  is_complaint: number;
  last_post_ts: number | null;
  content_hash: string | null;
  fetched_at: number;
}

export interface ChunkRow {
  id: number;
  doc_url: string;
  idx: number;
  post_url: string;
  text: string;
  title: string;
  is_rules: number;
  is_complaint: number;
  /** Путь раздела форума («… › Общие правила мероприятий»): по нему видно, что тема — правила отдельного ивента. */
  breadcrumbs?: string | null;
}

export interface RuleRow {
  id: number;
  doc_url: string;
  post_url: string;
  point: string;
  text: string;
  punishment: string | null;
  repeat_warn: number;
  doc_title: string;
  is_rules: number;
  is_complaint: number;
}

export interface FaqRow {
  id: number;
  guild_id: string;
  question: string;
  answer: string;
  keywords: string | null;
  created_by: string | null;
  created_at: number;
}

export interface UserSettingsRow {
  user_id: string;
  /** auto — как настроено на сервере (по умолчанию «кратко»). */
  answer_length: 'short' | 'long' | 'auto';
  show_sources: number;
  ai_provider: string | null;
  ai_model: string | null;
  ai_token: string | null;
  /** Дублировать уведомления о жалобах на ваш игровой ID в ЛС. */
  complaint_dm: number;
}

// ---------- meta ----------

export function getMeta(key: string): string | null {
  return get<{ value: string | null }>('SELECT value FROM meta WHERE key = ?', key)?.value ?? null;
}

/** Темы с правилами считаются устаревшими — при следующем обновлении скачиваются и режутся на фрагменты заново. */
export function expireRuleDocuments(): number {
  return run('UPDATE documents SET fetched_at = 0 WHERE is_rules = 1').changes;
}

export function setMeta(key: string, value: string): void {
  run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

// ---------- guilds ----------

export function getGuild(guildId: string): GuildRow | undefined {
  return get<GuildRow>('SELECT * FROM guilds WHERE guild_id = ?', guildId);
}

export function listGuilds(): GuildRow[] {
  return all<GuildRow>('SELECT * FROM guilds');
}

export function ensureGuildRow(guildId: string, refreshHours: number): GuildRow {
  run(
    'INSERT INTO guilds (guild_id, refresh_hours, created_at) VALUES (?, ?, ?) ON CONFLICT(guild_id) DO NOTHING',
    guildId,
    refreshHours,
    Date.now(),
  );
  attachSharedToken(guildId);
  return getGuild(guildId)!;
}

/**
 * Общий AI-токен (SHARED_AI_GUILD_ID): серверам без своего токена копируется токен основного сервера
 * (зашифрованная строка как есть — привязанные серверы узнаются по совпадению ai_token).
 * guildId = null — привязать все серверы без токена.
 */
export function attachSharedToken(guildId: string | null = null): number {
  const sharedId = config.sharedAiGuildId;
  if (!sharedId || guildId === sharedId) return 0;
  return copySharedAi(sharedId, null, guildId);
}

function copySharedAi(sharedId: string, oldToken: string | null, onlyGuildId: string | null): number {
  const src = getGuild(sharedId);
  if (oldToken === null && !src?.ai_token) return 0;
  const res = run(
    `UPDATE guilds SET ai_provider = ?, ai_token = ?, ai_model = ?
     WHERE guild_id != ? AND ai_token IS ?${onlyGuildId ? ' AND guild_id = ?' : ''}`,
    src?.ai_provider ?? null,
    src?.ai_token ?? null,
    src?.ai_model ?? null,
    sharedId,
    oldToken,
    ...(onlyGuildId ? [onlyGuildId] : []),
  );
  return Number(res.changes ?? 0);
}

type GuildField = Exclude<keyof GuildRow, 'guild_id' | 'created_at'>;

export function updateGuild(guildId: string, patch: Partial<Record<GuildField, Param>>): void {
  const keys = Object.keys(patch) as GuildField[];
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  // Меняется AI основного сервера — привязанные к его токену серверы получают то же самое.
  const sharedId = config.sharedAiGuildId;
  const syncShared = guildId === sharedId && keys.some((k) => k === 'ai_provider' || k === 'ai_token' || k === 'ai_model');
  const oldToken = syncShared ? (getGuild(guildId)?.ai_token ?? null) : null;
  // Имена колонок берутся только из типа GuildField, пользовательский ввод сюда не попадает.
  run(`UPDATE guilds SET ${sets} WHERE guild_id = ?`, ...keys.map((k) => patch[k] ?? null), guildId);
  if (syncShared && oldToken) copySharedAi(guildId, oldToken, null);
  if (syncShared) attachSharedToken(null);
}

// ---------- роли ----------

export function getRolePerms(guildId: string): RolePerm[] {
  return all<RolePerm>('SELECT * FROM role_perms WHERE guild_id = ?', guildId);
}

export function getRolePerm(guildId: string, roleId: string): RolePerm | undefined {
  return get<RolePerm>('SELECT * FROM role_perms WHERE guild_id = ? AND role_id = ?', guildId, roleId);
}

export function upsertRolePerm(p: RolePerm): void {
  run(
    `INSERT INTO role_perms (guild_id, role_id, can_ask, any_channel, manage_sources, manage_ai, view_logs, hourly_limit,
       dm_access, see_channels, can_write, see_settings, blocked_commands, max_player_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, role_id) DO UPDATE SET
       can_ask = excluded.can_ask, any_channel = excluded.any_channel, manage_sources = excluded.manage_sources,
       manage_ai = excluded.manage_ai, view_logs = excluded.view_logs, hourly_limit = excluded.hourly_limit,
       dm_access = excluded.dm_access, see_channels = excluded.see_channels, can_write = excluded.can_write,
       see_settings = excluded.see_settings, blocked_commands = excluded.blocked_commands,
       max_player_ids = excluded.max_player_ids`,
    p.guild_id,
    p.role_id,
    p.can_ask,
    p.any_channel,
    p.manage_sources,
    p.manage_ai,
    p.view_logs,
    p.hourly_limit,
    p.dm_access,
    p.see_channels,
    p.can_write,
    p.see_settings,
    p.blocked_commands,
    p.max_player_ids,
  );
}

export function deleteRolePerm(guildId: string, roleId: string): void {
  run('DELETE FROM role_perms WHERE guild_id = ? AND role_id = ?', guildId, roleId);
}

// ---------- источники ----------

export function listSources(scope: string): SourceRow[] {
  return all<SourceRow>('SELECT * FROM sources WHERE scope = ? ORDER BY id', scope);
}

export function getSource(id: number): SourceRow | undefined {
  return get<SourceRow>('SELECT * FROM sources WHERE id = ?', id);
}

export function addSource(scope: string, url: string, kind: string, addedBy: string | null): boolean {
  const r = run(
    'INSERT INTO sources (scope, url, kind, added_by, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope, url) DO NOTHING',
    scope,
    url,
    kind,
    addedBy,
    Date.now(),
  );
  return r.changes > 0;
}

export function deleteSource(id: number): void {
  run('DELETE FROM sources WHERE id = ?', id);
  deleteOrphanDocuments();
}

export function markSourceFetched(id: number, title: string | null, error: string | null): void {
  run(
    'UPDATE sources SET last_fetched_at = ?, title = COALESCE(?, title), last_error = ? WHERE id = ?',
    Date.now(),
    title,
    error,
    id,
  );
}

export function linkSourceDocs(sourceId: number, docUrls: string[]): void {
  transaction(() => {
    run('DELETE FROM source_docs WHERE source_id = ?', sourceId);
    for (const url of new Set(docUrls)) {
      run('INSERT OR IGNORE INTO source_docs (source_id, doc_url) VALUES (?, ?)', sourceId, url);
    }
  });
}

export function deleteOrphanDocuments(): number {
  return run('DELETE FROM documents WHERE url NOT IN (SELECT doc_url FROM source_docs)').changes;
}

// ---------- документы ----------

export function getDocument(url: string): DocumentRow | undefined {
  return get<DocumentRow>('SELECT * FROM documents WHERE url = ?', url);
}

export interface StoredChunk {
  postUrl: string;
  text: string;
}

export interface StoredRule {
  postUrl: string;
  point: string;
  text: string;
  punishment: string | null;
  repeatWarn: boolean;
}

export function saveDocument(doc: Omit<DocumentRow, 'fetched_at'>, chunks: StoredChunk[], rules: StoredRule[]): void {
  transaction(() => {
    run(
      `INSERT INTO documents (url, title, author, breadcrumbs, is_rules, is_complaint, last_post_ts, content_hash, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET title = excluded.title, author = excluded.author, breadcrumbs = excluded.breadcrumbs,
         is_rules = excluded.is_rules, is_complaint = excluded.is_complaint, last_post_ts = excluded.last_post_ts,
         content_hash = excluded.content_hash, fetched_at = excluded.fetched_at`,
      doc.url,
      doc.title,
      doc.author,
      doc.breadcrumbs,
      doc.is_rules,
      doc.is_complaint,
      doc.last_post_ts,
      doc.content_hash,
      Date.now(),
    );
    run('DELETE FROM chunks WHERE doc_url = ?', doc.url);
    run('DELETE FROM rules WHERE doc_url = ?', doc.url);
    chunks.forEach((c, i) => run('INSERT INTO chunks (doc_url, idx, post_url, text) VALUES (?, ?, ?, ?)', doc.url, i, c.postUrl, c.text));
    for (const r of rules) {
      run(
        'INSERT INTO rules (doc_url, post_url, point, text, punishment, repeat_warn) VALUES (?, ?, ?, ?, ?, ?)',
        doc.url,
        r.postUrl,
        r.point,
        r.text,
        r.punishment,
        r.repeatWarn ? 1 : 0,
      );
    }
  });
}

export function touchDocument(url: string, lastPostTs: number | null): void {
  run('UPDATE documents SET fetched_at = ?, last_post_ts = COALESCE(?, last_post_ts) WHERE url = ?', Date.now(), lastPostTs, url);
}

export function allChunks(): ChunkRow[] {
  return all<ChunkRow>(
    `SELECT c.id, c.doc_url, c.idx, c.post_url, c.text, d.title, d.is_rules, d.is_complaint, d.breadcrumbs
     FROM chunks c JOIN documents d ON d.url = c.doc_url`,
  );
}

/**
 * Каждый пункт правил — отдельный короткий фрагмент для поиска (строится из таблицы rules,
 * поэтому работает и для уже собранной базы без повторной загрузки форума). id отрицательные.
 */
export function ruleChunks(): ChunkRow[] {
  return all<ChunkRow>(
    `SELECT -r.id AS id, r.doc_url, 0 AS idx, r.post_url,
            'Пункт ' || r.point || ': ' || r.text || COALESCE(char(10) || 'Наказание: ' || r.punishment, '') AS text,
            d.title, d.is_rules, d.is_complaint, d.breadcrumbs
     FROM rules r JOIN documents d ON d.url = r.doc_url
     WHERE d.is_rules = 1 AND d.is_complaint = 0`,
  );
}

/** Пункты правил, в тексте которых встречается шаблон LIKE (например «%(DM)%»). */
export function rulesLike(pattern: string, limit = 10): RuleRow[] {
  return all<RuleRow>(
    `SELECT r.*, d.title AS doc_title, d.is_rules, d.is_complaint
     FROM rules r JOIN documents d ON d.url = r.doc_url
     WHERE r.text LIKE ?
     ORDER BY d.is_complaint, d.is_rules DESC, length(r.point), r.point
     LIMIT ?`,
    pattern,
    limit,
  );
}

/** URL документов, доступных в области (сервер или global). */
export function docUrlsForScope(scope: string): Set<string> {
  const rows = all<{ doc_url: string }>(
    'SELECT DISTINCT sd.doc_url FROM source_docs sd JOIN sources s ON s.id = sd.source_id WHERE s.scope = ?',
    scope,
  );
  return new Set(rows.map((r) => r.doc_url));
}

export function findRules(point: string): RuleRow[] {
  return all<RuleRow>(
    `SELECT r.*, d.title AS doc_title, d.is_rules, d.is_complaint
     FROM rules r JOIN documents d ON d.url = r.doc_url
     WHERE r.point = ?`,
    point,
  );
}

export function searchRulePoints(prefix: string, limit = 25): { point: string; text: string }[] {
  return all<{ point: string; text: string }>(
    `SELECT r.point, r.text FROM rules r JOIN documents d ON d.url = r.doc_url
     WHERE d.is_rules = 1 AND d.is_complaint = 0 AND r.point LIKE ?
     GROUP BY r.point ORDER BY length(r.point), r.point LIMIT ?`,
    `${prefix}%`,
    limit,
  );
}

export interface KbStats {
  sources: number;
  documents: number;
  chunks: number;
  rules: number;
}

export function kbStats(scope: string): KbStats {
  const sources = get<{ n: number }>('SELECT COUNT(*) AS n FROM sources WHERE scope = ?', scope)?.n ?? 0;
  const documents =
    get<{ n: number }>(
      'SELECT COUNT(DISTINCT sd.doc_url) AS n FROM source_docs sd JOIN sources s ON s.id = sd.source_id WHERE s.scope = ?',
      scope,
    )?.n ?? 0;
  const chunks =
    get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM chunks WHERE doc_url IN
        (SELECT sd.doc_url FROM source_docs sd JOIN sources s ON s.id = sd.source_id WHERE s.scope = ?)`,
      scope,
    )?.n ?? 0;
  const rules =
    get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM rules WHERE doc_url IN
        (SELECT sd.doc_url FROM source_docs sd JOIN sources s ON s.id = sd.source_id WHERE s.scope = ?)`,
      scope,
    )?.n ?? 0;
  return { sources, documents, chunks, rules };
}

// ---------- изменения правил ----------

export interface RuleEventRow {
  id: number;
  doc_url: string;
  doc_title: string;
  kind: 'added' | 'removed' | 'changed' | 'new_doc';
  point: string | null;
  before_text: string | null;
  before_punishment: string | null;
  after_text: string | null;
  after_punishment: string | null;
  post_url: string | null;
  ts: number;
}

export type NewRuleEvent = Omit<RuleEventRow, 'id' | 'ts'>;

/**
 * Фрагмент форума, в котором записан пункт (номер в начале строки). Пункт из таблицы rules — одна строка
 * без соседних подпунктов, списков и «Исключение»: «6.6.1 амуниция за стрелу» без «6.6.3 не более $1.000.000».
 */
export function chunkForRulePoint(docUrl: string, point: string): { text: string; post_url: string } | undefined {
  return all<{ text: string; post_url: string }>('SELECT text, post_url FROM chunks WHERE doc_url = ? ORDER BY idx', docUrl).find((c) =>
    new RegExp(`(^|\\n)\\s*(Пункт\\s*)?${point.replace(/\./g, '\\.')}\\.?[\\s:]`).test(c.text),
  );
}

/** Фрагменты одной темы по порядку — чтобы собрать её полный текст. */
export function chunkTextsForDoc(docUrl: string): string[] {
  return all<{ text: string }>('SELECT text FROM chunks WHERE doc_url = ? ORDER BY idx', docUrl).map((r) => r.text);
}

export function rulesForDoc(docUrl: string): RuleRow[] {
  return all<RuleRow>(
    `SELECT r.*, d.title AS doc_title, d.is_rules, d.is_complaint
     FROM rules r JOIN documents d ON d.url = r.doc_url WHERE r.doc_url = ? ORDER BY r.id`,
    docUrl,
  );
}

export function addRuleEvents(events: NewRuleEvent[]): void {
  if (!events.length) return;
  const ts = Date.now();
  transaction(() => {
    for (const e of events) {
      run(
        `INSERT INTO rule_events (doc_url, doc_title, kind, point, before_text, before_punishment, after_text, after_punishment, post_url, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        e.doc_url,
        e.doc_title,
        e.kind,
        e.point,
        e.before_text,
        e.before_punishment,
        e.after_text,
        e.after_punishment,
        e.post_url,
        ts,
      );
    }
  });
}

export function maxRuleEventId(): number {
  return get<{ n: number | null }>('SELECT MAX(id) AS n FROM rule_events')?.n ?? 0;
}

export function ruleEventsBetween(afterId: number, uptoId: number): RuleEventRow[] {
  return all<RuleEventRow>('SELECT * FROM rule_events WHERE id > ? AND id <= ? ORDER BY id', afterId, uptoId);
}

export function pruneRuleEvents(olderThanMs: number): void {
  run('DELETE FROM rule_events WHERE ts < ?', Date.now() - olderThanMs);
}

// ---------- FAQ ----------

export function listFaq(guildId: string): FaqRow[] {
  return all<FaqRow>('SELECT * FROM faq WHERE guild_id = ? ORDER BY id', guildId);
}

export function getFaq(id: number): FaqRow | undefined {
  return get<FaqRow>('SELECT * FROM faq WHERE id = ?', id);
}

export function addFaq(guildId: string, question: string, answer: string, keywords: string | null, userId: string): number {
  return run(
    'INSERT INTO faq (guild_id, question, answer, keywords, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    guildId,
    question,
    answer,
    keywords,
    userId,
    Date.now(),
  ).lastInsertRowid;
}

export function deleteFaq(id: number): void {
  run('DELETE FROM faq WHERE id = ?', id);
}

// ---------- пользовательские настройки ----------

export function getUserSettings(userId: string): UserSettingsRow {
  return (
    get<UserSettingsRow>('SELECT * FROM user_settings WHERE user_id = ?', userId) ?? {
      user_id: userId,
      answer_length: 'auto',
      show_sources: 1,
      ai_provider: null,
      ai_model: null,
      ai_token: null,
      complaint_dm: 1,
    }
  );
}

export function saveUserSettings(s: UserSettingsRow): void {
  run(
    `INSERT INTO user_settings (user_id, answer_length, show_sources, ai_provider, ai_model, ai_token, complaint_dm)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET answer_length = excluded.answer_length, show_sources = excluded.show_sources,
       ai_provider = excluded.ai_provider, ai_model = excluded.ai_model, ai_token = excluded.ai_token,
       complaint_dm = excluded.complaint_dm`,
    s.user_id,
    s.answer_length,
    s.show_sources,
    s.ai_provider,
    s.ai_model,
    s.ai_token,
    s.complaint_dm,
  );
}

// ---------- игровые ID и жалобы ----------

/** Лимит ID, если у пользователя нет настроенных ролей ни на одном сервере. */
export const DEFAULT_MAX_IDS_PER_USER = 3;

export function listPlayerIds(userId: string): string[] {
  return all<{ game_id: string }>('SELECT game_id FROM player_ids WHERE user_id = ? ORDER BY created_at', userId).map((r) => r.game_id);
}

export function ownerOfGameId(gameId: string): string | null {
  return get<{ user_id: string }>('SELECT user_id FROM player_ids WHERE game_id = ?', gameId)?.user_id ?? null;
}

/** limit — сколько ID можно привязать (0 — без лимита), см. playerIdLimit(). */
export function addPlayerId(userId: string, gameId: string, limit: number): 'ok' | 'taken' | 'limit' | 'exists' {
  const owner = ownerOfGameId(gameId);
  if (owner === userId) return 'exists';
  if (owner) return 'taken';
  if (limit > 0 && listPlayerIds(userId).length >= limit) return 'limit';
  run('INSERT INTO player_ids (game_id, user_id, created_at) VALUES (?, ?, ?)', gameId, userId, Date.now());
  return 'ok';
}

export function removePlayerId(gameId: string, userId: string | null): boolean {
  // userId = null — удаление администратором (любой привязки).
  const r = userId
    ? run('DELETE FROM player_ids WHERE game_id = ? AND user_id = ?', gameId, userId)
    : run('DELETE FROM player_ids WHERE game_id = ?', gameId);
  return r.changes > 0;
}

export function countPlayerIds(): number {
  return get<{ n: number }>('SELECT COUNT(*) AS n FROM player_ids')?.n ?? 0;
}

export interface ComplaintThreadRow {
  url: string;
  offender_id: string | null;
  /** Ник из поля «Ник игрока» (на кого жалоба). */
  offender_nick: string | null;
  /** Автор темы (кто подал жалобу). */
  author: string | null;
  title: string;
  prefix: string | null;
  last_post_ts: number | null;
  first_seen: number;
}

export function getComplaintThread(url: string): ComplaintThreadRow | undefined {
  return get<ComplaintThreadRow>('SELECT * FROM complaint_threads WHERE url = ?', url);
}

export function countComplaintThreads(): number {
  return get<{ n: number }>('SELECT COUNT(*) AS n FROM complaint_threads')?.n ?? 0;
}

export function saveComplaintThread(t: Omit<ComplaintThreadRow, 'first_seen'>): void {
  run(
    `INSERT INTO complaint_threads (url, offender_id, offender_nick, author, title, prefix, last_post_ts, first_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET offender_id = excluded.offender_id, offender_nick = excluded.offender_nick, author = excluded.author,
       title = excluded.title, prefix = excluded.prefix, last_post_ts = excluded.last_post_ts`,
    t.url,
    t.offender_id,
    t.offender_nick,
    t.author,
    t.title,
    t.prefix,
    t.last_post_ts,
    Date.now(),
  );
}

export interface ComplaintEventRow {
  id: number;
  url: string;
  offender_id: string;
  title: string;
  prefix: string | null;
  /** new — новая жалоба, status — сменился статус, existing — уже была на форуме (найдена при привязке ID). */
  kind: 'new' | 'status' | 'existing';
  dm_sent: number;
  ts: number;
}

export function addComplaintEvent(e: Omit<ComplaintEventRow, 'id' | 'ts' | 'dm_sent'>): void {
  run(
    'INSERT INTO complaint_events (url, offender_id, title, prefix, kind, ts) VALUES (?, ?, ?, ?, ?, ?)',
    e.url,
    e.offender_id,
    e.title,
    e.prefix,
    e.kind,
    Date.now(),
  );
}

export function maxComplaintEventId(): number {
  return get<{ n: number | null }>('SELECT MAX(id) AS n FROM complaint_events')?.n ?? 0;
}

export function complaintEventsBetween(afterId: number, uptoId: number): ComplaintEventRow[] {
  return all<ComplaintEventRow>('SELECT * FROM complaint_events WHERE id > ? AND id <= ? ORDER BY id', afterId, uptoId);
}

export function pendingDmComplaintEvents(): ComplaintEventRow[] {
  return all<ComplaintEventRow>('SELECT * FROM complaint_events WHERE dm_sent = 0 ORDER BY id LIMIT 100');
}

export function markComplaintEventDm(id: number): void {
  run('UPDATE complaint_events SET dm_sent = 1 WHERE id = ?', id);
}

/** Последние жалобы на этот ID (из отслеживаемых тем). */
export function recentComplaintsFor(gameId: string, limit = 5): ComplaintThreadRow[] {
  return all<ComplaintThreadRow>('SELECT * FROM complaint_threads WHERE offender_id = ? ORDER BY first_seen DESC LIMIT ?', gameId, limit);
}

export function pruneComplaintEvents(olderThanMs: number): void {
  run('DELETE FROM complaint_events WHERE ts < ?', Date.now() - olderThanMs);
}

// ---------- статистика и аудит ----------

export function recordAiRequest(guildId: string | null, userId: string, kind: string, ok: boolean): void {
  run('INSERT INTO ai_requests (guild_id, user_id, kind, ok, ts) VALUES (?, ?, ?, ?, ?)', guildId, userId, kind, ok ? 1 : 0, Date.now());
}

export function aiRequestStats(guildId: string): { total: number; day: number; failed: number } {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const total = get<{ n: number }>('SELECT COUNT(*) AS n FROM ai_requests WHERE guild_id = ?', guildId)?.n ?? 0;
  const day = get<{ n: number }>('SELECT COUNT(*) AS n FROM ai_requests WHERE guild_id = ? AND ts >= ?', guildId, since)?.n ?? 0;
  const failed = get<{ n: number }>('SELECT COUNT(*) AS n FROM ai_requests WHERE guild_id = ? AND ok = 0', guildId)?.n ?? 0;
  return { total, day, failed };
}

export function addAudit(guildId: string | null, userId: string, action: string, details: string | null): void {
  run('INSERT INTO audit_log (guild_id, user_id, action, details, ts) VALUES (?, ?, ?, ?, ?)', guildId, userId, action, details, Date.now());
}

let kbVersionCache: { at: number; value: string } | null = null;

/**
 * Версия базы знаний: меняется, когда меняется содержимое любой темы (content_hash) или их набор.
 * Для кэша готовых ответов — после обновления форума ответы генерируются заново. Пересчёт не чаще раза в минуту.
 */
export function knowledgeVersion(): string {
  if (kbVersionCache && Date.now() - kbVersionCache.at < 60_000) return kbVersionCache.value;
  const row = get<{ v: string | null }>(
    "SELECT group_concat(url || ':' || coalesce(content_hash, ''), '|') AS v FROM (SELECT url, content_hash FROM documents ORDER BY url)",
  );
  kbVersionCache = { at: Date.now(), value: row?.v ?? '' };
  return kbVersionCache.value;
}
