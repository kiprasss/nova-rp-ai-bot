import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from './config.js';
import { all, get } from './db/database.js';
import { GLOBAL_SCOPE, addSource, linkSourceDocs, listSources, saveDocument, type StoredChunk, type StoredRule } from './db/repo.js';
import { log } from './util/logger.js';

/**
 * Снимок базы правил в репозитории (seed/knowledge.json). Нужен, когда бот запускается на новом
 * хостинге без data/bot.db, а форум недоступен (например, закрыт защитой от ботов).
 * Жалобы в снимок не попадают — только темы правил.
 */
export const SEED_FILE = join(PROJECT_ROOT, 'seed', 'knowledge.json');

interface SeedDoc {
  url: string;
  title: string;
  breadcrumbs: string | null;
  is_complaint: number;
  chunks: StoredChunk[];
  rules: StoredRule[];
}

/** Экспорт тем правил из текущей базы в seed/knowledge.json. */
export function exportSeed(): number {
  const docs = all<{ url: string; title: string; breadcrumbs: string | null; is_complaint: number }>(
    `SELECT url, title, breadcrumbs, is_complaint FROM documents
     WHERE is_rules = 1 OR (title LIKE 'Правила%' AND is_complaint = 1 AND title NOT LIKE '%ID%')
     ORDER BY url`,
  );
  const out: SeedDoc[] = docs.map((d) => ({
    ...d,
    chunks: all<StoredChunk>('SELECT post_url AS postUrl, text FROM chunks WHERE doc_url = ? ORDER BY idx', d.url),
    rules: all<{ postUrl: string; point: string; text: string; punishment: string | null; repeat_warn: number }>(
      'SELECT post_url AS postUrl, point, text, punishment, repeat_warn FROM rules WHERE doc_url = ? ORDER BY id',
      d.url,
    ).map((r) => ({ postUrl: r.postUrl, point: r.point, text: r.text, punishment: r.punishment, repeatWarn: r.repeat_warn === 1 })),
  }));
  writeFileSync(SEED_FILE, JSON.stringify({ exportedAt: new Date().toISOString(), documents: out }, null, 1));
  return out.length;
}

/** Если база знаний пуста — загружает снимок правил и делает его доступным всем серверам. */
export function importSeedIfEmpty(): number {
  const count = get<{ n: number }>('SELECT COUNT(*) AS n FROM documents')?.n ?? 0;
  if (count > 0 || !existsSync(SEED_FILE)) return 0;
  const seed = JSON.parse(readFileSync(SEED_FILE, 'utf8')) as { documents: SeedDoc[] };
  for (const d of seed.documents) {
    saveDocument(
      {
        url: d.url,
        title: d.title,
        author: null,
        breadcrumbs: d.breadcrumbs,
        is_rules: d.is_complaint ? 0 : 1,
        is_complaint: d.is_complaint,
        last_post_ts: null,
        content_hash: 'seed',
      },
      d.chunks,
      d.rules,
    );
    // Привязываем к глобальной области: серверы без собственных тем ищут по ней.
    addSource(GLOBAL_SCOPE, d.url, 'thread', null);
    const src = listSources(GLOBAL_SCOPE).find((s) => s.url === d.url);
    if (src) linkSourceDocs(src.id, [d.url]);
  }
  log.info(`База знаний была пуста — загружен снимок правил: тем ${seed.documents.length}`);
  return seed.documents.length;
}
