import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { invalidateSearchIndex } from '../ai/search.js';
import {
  GLOBAL_SCOPE,
  deleteOrphanDocuments,
  getDocument,
  linkSourceDocs,
  listSources,
  markSourceFetched,
  saveDocument,
  setMeta,
  touchDocument,
  addRuleEvents,
  rulesForDoc,
  type NewRuleEvent,
  updateGuild,
  type StoredChunk,
  type StoredRule,
} from '../db/repo.js';
import { log } from '../util/logger.js';
import { chunkText } from './chunker.js';
import { ForumBlockedError, PoliteFetcher } from './http.js';
import { parseForum, parseThread, type ParsedPost, type ThreadListItem } from './parser.js';
import { diffRules } from './ruleDiff.js';
import { extractRules } from './rules.js';
import { isSensitiveLabel, sanitizeComplaintTitle, sanitizeField, sanitizeText } from './sanitize.js';
import { pageUrl } from './url.js';

export interface RefreshReport {
  scope: string;
  sources: number;
  threadsFetched: number;
  threadsCached: number;
  documents: number;
  errors: string[];
  ruleChanges: number;
  /** Форум отдал страницу антибот-защиты. */
  blocked: boolean;
  durationMs: number;
}

const fetcher = new PoliteFetcher({ userAgent: config.userAgent, delayMs: config.scrapeDelayMs });
/** Общий загрузчик: обновление базы и проверка жалоб идут в одной очереди с паузами. */
export const forumFetcher = fetcher;

let chain: Promise<unknown> = Promise.resolve();
const pending = new Map<string, Promise<RefreshReport>>();

/** Ставит обновление области (ID сервера или global) в общую очередь: одновременно идёт только один сбор. */
export function refreshScope(scope: string): Promise<RefreshReport> {
  const existing = pending.get(scope);
  if (existing) return existing;
  const p = chain.then(() => doRefresh(scope)).finally(() => pending.delete(scope));
  chain = p.catch(() => undefined);
  pending.set(scope, p);
  return p;
}

export function isRefreshing(scope: string): boolean {
  return pending.has(scope);
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function doRefresh(scope: string): Promise<RefreshReport> {
  const started = Date.now();
  const report: RefreshReport = { scope, sources: 0, threadsFetched: 0, threadsCached: 0, documents: 0, ruleChanges: 0, blocked: false, errors: [], durationMs: 0 };
  const sources = listSources(scope);
  report.sources = sources.length;
  log.info(`Обновление базы знаний [${scope}]: источников ${sources.length}`);

  for (const src of sources) {
    try {
      if (src.kind === 'thread') {
        const doc = await indexThread(src.url, null, report, false);
        linkSourceDocs(src.id, [doc.url]);
        markSourceFetched(src.id, doc.title, null);
        report.documents++;
      } else {
        // Новые темы правил объявляем только для разделов, которые уже индексировались раньше.
        const { title, urls } = await indexForum(src.url, report, src.last_fetched_at !== null);
        linkSourceDocs(src.id, urls);
        markSourceFetched(src.id, title, urls.length ? null : 'Темы не найдены');
        report.documents += urls.length;
      }
    } catch (err) {
      if (err instanceof ForumBlockedError) {
        report.blocked = true;
        report.errors.push(err.message);
        markSourceFetched(src.id, null, 'Форум закрыт защитой от ботов');
        log.warn(err.message);
        break; // остальные источники тоже не откроются
      }
      report.errors.push(`${src.url}: ${errMsg(err)}`);
      markSourceFetched(src.id, null, errMsg(err));
      log.warn(`Источник ${src.url} не обработан`, err);
    }
  }

  deleteOrphanDocuments();
  if (scope === GLOBAL_SCOPE) setMeta('global_last_refresh', String(Date.now()));
  else updateGuild(scope, { last_refresh_at: Date.now() });
  invalidateSearchIndex();
  report.durationMs = Date.now() - started;
  log.info(
    `Обновление [${scope}] завершено: скачано ${report.threadsFetched}, из кэша ${report.threadsCached}, ошибок ${report.errors.length}`,
  );
  return report;
}

function isComplaintThread(fields: { label: string }[], breadcrumbs: string[]): boolean {
  return fields.some((f) => isSensitiveLabel(f.label)) || breadcrumbs.some((b) => /жалоб/i.test(b));
}

async function indexThread(
  url: string,
  listingTs: number | null,
  report: RefreshReport,
  allowNewDocEvent: boolean,
): Promise<{ url: string; title: string }> {
  const cached = getDocument(url);
  if (cached) {
    const fresh = Date.now() - cached.fetched_at < config.scrapeCacheMinutes * 60_000;
    // Жалобы почти не редактируются: если новых сообщений нет — берём из кэша.
    const unchanged = listingTs !== null && cached.last_post_ts === listingTs && cached.is_complaint === 1;
    if (fresh || unchanged) {
      report.threadsCached++;
      if (unchanged && !fresh) touchDocument(url, listingTs);
      return { url, title: cached.title };
    }
  }

  const first = parseThread(await fetcher.get(url), url);
  const posts: ParsedPost[] = [...first.posts];
  const pages = Math.min(first.totalPages, config.scrapeMaxPagesPerThread);
  for (let p = 2; p <= pages; p++) {
    try {
      posts.push(...parseThread(await fetcher.get(pageUrl(url, p)), url).posts);
    } catch (err) {
      if (err instanceof ForumBlockedError) throw err;
      report.errors.push(`${pageUrl(url, p)}: ${errMsg(err)}`);
    }
  }
  report.threadsFetched++;

  const complaint = isComplaintThread(first.fields, first.breadcrumbs);
  const isRules = !complaint && (/правил/i.test(first.title) || first.breadcrumbs.some((b) => /правил/i.test(b)));
  const title = complaint ? sanitizeComplaintTitle(first.title) : first.title;

  const header: string[] = [];
  if (first.prefix) header.push(`Статус/метка темы: ${first.prefix}`);
  for (const f of first.fields) header.push(`${f.label}: ${complaint ? sanitizeField(f.label, f.value) : f.value}`);

  const chunks: StoredChunk[] = [];
  const rules: StoredRule[] = [];
  const seenPoints = new Set<string>();
  posts.forEach((post, i) => {
    const body = complaint ? sanitizeText(post.text) : post.text;
    const text = i === 0 && header.length ? `${header.join('\n')}\n\n${body}` : body;
    for (const c of chunkText(text)) chunks.push({ postUrl: post.url, text: c });
    for (const r of extractRules(post.text)) {
      if (seenPoints.has(r.point)) continue;
      seenPoints.add(r.point);
      rules.push({ postUrl: post.url, ...r });
    }
  });

  // Отдельные фрагменты «по пункту» строятся при поиске из таблицы rules (repo.ruleChunks).

  const hash = createHash('sha1').update(posts.map((p) => p.text).join('\n')).digest('hex');

  // Изменения правил (жалобы и прочие темы не отслеживаются) → события для канала #ai-правила.
  if (isRules) {
    const events: NewRuleEvent[] = [];
    const base = { doc_url: url, doc_title: title };
    if (cached?.is_rules && cached.content_hash !== hash) {
      const diff = diffRules(rulesForDoc(url), rules);
      for (const r of diff.added) {
        events.push({ ...base, kind: 'added', point: r.point, before_text: null, before_punishment: null, after_text: r.text, after_punishment: r.punishment, post_url: r.postUrl });
      }
      for (const c of diff.changed) {
        events.push({ ...base, kind: 'changed', point: c.point, before_text: c.before.text, before_punishment: c.before.punishment, after_text: c.after.text, after_punishment: c.after.punishment, post_url: c.after.postUrl });
      }
      for (const r of diff.removed) {
        events.push({ ...base, kind: 'removed', point: r.point, before_text: r.text, before_punishment: r.punishment, after_text: null, after_punishment: null, post_url: url });
      }
    } else if (!cached && allowNewDocEvent) {
      events.push({ ...base, kind: 'new_doc', point: null, before_text: null, before_punishment: null, after_text: `Пунктов правил: ${rules.length}`, after_punishment: null, post_url: url });
    }
    addRuleEvents(events);
    report.ruleChanges += events.length;
  }

  saveDocument(
    {
      url,
      title,
      author: complaint ? null : (posts[0]?.author ?? null),
      breadcrumbs: first.breadcrumbs.join(' › '),
      is_rules: isRules ? 1 : 0,
      is_complaint: complaint ? 1 : 0,
      last_post_ts: listingTs ?? cached?.last_post_ts ?? null,
      content_hash: hash,
    },
    chunks,
    rules,
  );
  return { url, title };
}

async function indexForum(url: string, report: RefreshReport, allowNewDocEvent: boolean): Promise<{ title: string; urls: string[] }> {
  const items: ThreadListItem[] = [];
  let title = '';

  const collect = async (forumUrl: string, depth: number) => {
    const firstPage = parseForum(await fetcher.get(forumUrl), config.forumBaseUrl);
    if (depth === 0) title = firstPage.title;
    items.push(...firstPage.threads);
    const pages = Math.min(firstPage.totalPages, config.scrapeForumPages);
    for (let p = 2; p <= pages; p++) {
      try {
        items.push(...parseForum(await fetcher.get(pageUrl(forumUrl, p)), config.forumBaseUrl).threads);
      } catch (err) {
        if (err instanceof ForumBlockedError) throw err;
        report.errors.push(`${pageUrl(forumUrl, p)}: ${errMsg(err)}`);
      }
    }
    if (depth === 0) {
      for (const sub of firstPage.subforums) {
        try {
          await collect(sub.url, depth + 1);
        } catch (err) {
          if (err instanceof ForumBlockedError) throw err;
          report.errors.push(`${sub.url}: ${errMsg(err)}`);
        }
      }
    }
  };
  await collect(url, 0);

  const unique = new Map<string, ThreadListItem>();
  for (const it of items) if (!unique.has(it.url)) unique.set(it.url, it);
  const ordered = [...unique.values()]
    .sort((a, b) => Number(b.sticky) - Number(a.sticky) || (b.lastPostTs ?? 0) - (a.lastPostTs ?? 0))
    .slice(0, config.scrapeMaxThreadsPerSource);

  const urls: string[] = [];
  for (const t of ordered) {
    try {
      urls.push((await indexThread(t.url, t.lastPostTs, report, allowNewDocEvent)).url);
    } catch (err) {
      // Форум закрыт защитой — прерываем, иначе источник потеряет ссылки на уже собранные темы.
      if (err instanceof ForumBlockedError) throw err;
      report.errors.push(`${t.url}: ${errMsg(err)}`);
    }
  }
  return { title, urls };
}
